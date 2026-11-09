import { z } from "zod";
import type { Locator } from "playwright";
import { expect } from "playwright/test";
import { BrowserSession } from "../testing/browser.js";
import type { Step } from "../testing/spec.js";

const selector = z.string().max(1000);
export const jiraAdapterSchema = z
  .object({
    schemaVersion: z.literal(1),
    allowedOrigins: z
      .array(
        z
          .string()
          .url()
          .max(2000)
          .refine(
            (value) =>
              ["http:", "https:"].includes(new URL(value).protocol) &&
              new URL(value).origin === value,
            "请输入完整 origin，不包含路径",
          ),
      )
      .max(10),
    issueKey: selector.min(1),
    title: selector.min(1),
    description: selector,
    acceptanceCriteria: selector,
    comments: selector.min(1),
    commentsOpen: selector,
    status: selector.min(1),
    login: selector.min(1),
    denied: selector,
    commentOpen: selector,
    commentInput: selector.min(1),
    commentSubmit: selector.min(1),
    statusOpen: selector,
    statusOptions: selector.min(1),
    statusConfirm: selector,
  })
  .strict();
export type JiraAdapter = z.infer<typeof jiraAdapterSchema>;

export const defaultJiraAdapter: JiraAdapter = {
  schemaVersion: 1,
  allowedOrigins: [],
  issueKey:
    '#key-val, [data-testid="issue-key"], [data-testid="issue.views.issue-base.foundation.breadcrumbs.current-issue.item"]',
  title: '#summary-val, [data-testid="issue-title"], h1',
  description: '#description-val, [data-testid="issue-description"]',
  acceptanceCriteria:
    '[data-testid="acceptance-criteria"], #acceptance-criteria',
  comments:
    '#issue_actions_container, [data-testid="issue-comments"], [data-testid="issue.views.issue-base.activity.comments-list"]',
  commentsOpen: '#all-tabpanel, [data-testid="comments-tab"]',
  status: '#status-val, [data-testid="issue-status"]',
  login:
    'input[type="password"], form[action*="login"], [data-testid="login-form"], input[autocomplete="one-time-code"]',
  denied:
    '[data-testid="access-denied"], [data-testid="issue-not-found"], .jira-permission-error',
  commentOpen:
    '#footer-comment-button, [data-testid="add-comment"], button:has-text("Add comment"), button:has-text("添加评论")',
  commentInput:
    '#comment, textarea[name="comment"], [data-testid="comment-input"], [contenteditable="true"][role="textbox"]',
  commentSubmit:
    '#issue-comment-add-submit, [data-testid="comment-submit"], button:has-text("Save comment"), button:has-text("保存评论")',
  statusOpen: '#opsbar-transitions_more, [data-testid="status-menu"]',
  statusOptions:
    '[data-testid="status-option"], #opsbar-transitions_more_drop a, [role="menuitem"]',
  statusConfirm:
    '[data-testid="status-confirm"], #issue-workflow-transition-submit',
};

export function parseJiraUrl(raw: string) {
  const url = new URL(raw);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("请提供不含凭据的 HTTP/HTTPS Jira Ticket 链接");
  const key =
    url.pathname.match(/\/browse\/([A-Za-z][A-Za-z0-9_]*-\d+)(?:\/|$)/)?.[1] ??
    url.searchParams.get("selectedIssue");
  if (!key || !/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(key))
    throw new Error(
      "Jira 链接需要包含 /browse/项目编号-数字 或 selectedIssue 参数",
    );
  url.hash = "";
  return { url: url.href, origin: url.origin, key: key.toUpperCase() };
}

export class JiraBrowser {
  constructor(
    readonly browser: BrowserSession,
    readonly adapter: JiraAdapter,
  ) {}

  async readIssue(url: string) {
    const issue = await this.ensureTicket(url);
    await this.openComments();
    await this.ensureTicket(url, false);
    const fields = {
      title: await this.text("title", true),
      description: await this.text("description"),
      acceptanceCriteria: await this.text("acceptanceCriteria"),
      status: await this.text("status"),
      comments: await this.text("comments"),
    };
    return {
      ...issue,
      ...fields,
      missingFields: Object.entries(fields)
        .filter(([key, value]) => key !== "comments" && !value)
        .map(([key]) => key),
      capturedAt: new Date().toISOString(),
    };
  }

  async publishResult(url: string, body: string, marker: string) {
    const issue = await this.ensureTicket(url);
    await this.openComments();
    await this.ensureTicket(url, false);
    const comment = body.includes(marker)
      ? body.trim()
      : `${body.trim()}\n\n${marker}`;
    const priorComments = this.commentRegion();
    await priorComments.waitFor({ state: "attached", timeout: 10000 });
    const existing = (await priorComments.innerText()).trim();
    if (existing.includes(marker)) {
      await expect(priorComments).toContainText(body.trim(), { timeout: 15000 });
      return {
        ...issue,
        marker,
        alreadyPublished: true,
        comment: existing.slice(0, 60000),
      };
    }
    if (
      !(await this.visible(this.adapter.commentInput).isVisible()) &&
      this.adapter.commentOpen
    )
      await this.click(this.adapter.commentOpen);
    await this.ensureTicket(url, false);
    if (
      !(await this.visible(this.adapter.commentInput).isVisible()) &&
      this.adapter.commentOpen
    )
      await this.click(this.adapter.commentOpen);
    const input = this.visible(this.adapter.commentInput);
    this.browser.recordAction("fill", this.adapter.commentInput);
    await input.fill(comment);
    await this.browser.waitForInterventions();
    await this.click(this.adapter.commentSubmit);
    await this.ensureTicket(url, false);
    await this.openComments();
    const comments = this.commentRegion();
    await expect(comments).toContainText(marker, { timeout: 15000 });
    await expect(comments).toContainText(body.trim(), { timeout: 15000 });
    await this.browser.saveStorageState();
    return { ...issue, marker, alreadyPublished: false, comment };
  }

  async transitionIssue(
    url: string,
    targetStatus: string,
    transitionLabel = targetStatus,
  ) {
    const issue = await this.ensureTicket(url);
    const previousStatus = await this.text("status", true);
    if (previousStatus === targetStatus)
      return {
        ...issue,
        previousStatus,
        status: previousStatus,
        changed: false,
      };
    if (this.adapter.statusOpen) await this.click(this.adapter.statusOpen);
    const options = this.browser.page
      .locator(this.adapter.statusOptions)
      .filter({ visible: true });
    await options.first().waitFor({ state: "visible", timeout: 10000 });
    const names = (await options.allTextContents()).map((text) => text.trim());
    const index = names.findIndex((name) => name === transitionLabel);
    if (index < 0)
      throw new Error(
        `Jira 当前可用状态转换为 ${names.join("、") || "未找到，请检查状态选项选择器"}，无法选择 ${transitionLabel}`,
      );
    await this.click(this.adapter.statusOptions, options.nth(index));
    if (this.adapter.statusConfirm) {
      const confirmation = this.visible(this.adapter.statusConfirm);
      await confirmation
        .waitFor({ state: "visible", timeout: 1500 })
        .catch(() => {});
      if (await confirmation.isVisible())
        await this.click(this.adapter.statusConfirm);
    }
    await this.ensureTicket(url, false);
    await expect(this.visible(this.adapter.status)).toHaveText(targetStatus, {
      timeout: 15000,
    });
    await this.browser.saveStorageState();
    return {
      ...issue,
      previousStatus,
      status: await this.text("status", true),
      changed: true,
    };
  }

  async inspect(url: string) {
    const issue = parseJiraUrl(url);
    if (issue.origin !== new URL(this.browser.baseUrl).origin)
      throw new Error("此 Jira 浏览器只能访问当前配置的 Jira 站点");
    if (this.browser.page.url() !== issue.url)
      await this.browser.step({ action: "navigate", url: issue.url });
    return this.browser.inspect(true);
  }

  async investigate(step: Step) {
    if (!["click", "press", "waitFor"].includes(step.action))
      throw new Error(
        "Jira 页面调查支持点击、按键和等待元素；写入结果请使用对应的发布或状态脚本",
      );
    await this.browser.step(step);
    return this.browser.inspect();
  }

  private visible(selector: string): Locator {
    return this.browser.page
      .locator(selector || "[data-looplab-missing-selector]")
      .filter({ visible: true })
      .first();
  }
  private commentRegion() {
    // An existing empty comment list can legitimately have no visible box.
    return this.browser.page.locator(this.adapter.comments).first();
  }
  private async text(
    field:
      "title" | "description" | "acceptanceCriteria" | "status" | "comments",
    required = false,
  ) {
    const target =
      field === "comments"
        ? this.commentRegion()
        : this.visible(this.adapter[field]);
    if (
      !required &&
      !(field === "comments" ? await target.count() : await target.isVisible())
    )
      return "";
    const value = (await target.innerText({ timeout: 10000 })).trim();
    if (required && !value)
      throw new Error(`Jira ${field} 字段为空，请检查适配脚本`);
    return value.slice(0, 60000);
  }
  private async click(selector: string, target?: Locator) {
    await this.browser.waitForInterventions();
    this.browser.recordAction("click", selector);
    try {
      await (target ?? this.visible(selector)).click();
    } finally {
      await this.browser.waitForInterventions();
    }
  }
  private async openComments() {
    if (
      this.adapter.commentsOpen &&
      (await this.visible(this.adapter.commentsOpen).isVisible())
    )
      await this.click(this.adapter.commentsOpen);
  }
  private async ensureTicket(raw: string, navigate = true) {
    const issue = parseJiraUrl(raw);
    if (issue.origin !== new URL(this.browser.baseUrl).origin)
      throw new Error("此 Jira 浏览器只能访问当前配置的 Jira 站点");
    if (navigate) {
      this.browser.returnToMainPage();
      await this.browser.step({ action: "navigate", url: issue.url });
    }
    for (;;) {
      this.browser.signal.throwIfAborted();
      const page = this.browser.page;
      const key = this.visible(this.adapter.issueKey);
      const login = this.visible(this.adapter.login);
      const denied = this.visible(this.adapter.denied);
      await key
        .or(login)
        .or(denied)
        .first()
        .waitFor({ state: "visible", timeout: 10000 })
        .catch(() => {});
      if (page !== this.browser.page) continue;
      if (await denied.isVisible())
        throw new Error(
          `Jira 页面拒绝访问或 Ticket 不存在：${(await denied.innerText()).slice(0, 300)}`,
        );
      if (
        new URL(page.url()).origin === issue.origin &&
        !(await login.isVisible()) &&
        (await key.isVisible())
      ) {
        const actualKey = (await key.innerText()).trim().toUpperCase();
        if (actualKey !== issue.key)
          throw new Error(
            `Jira 页面标识 ${actualKey} 与请求 ${issue.key} 不一致`,
          );
        await this.browser.saveStorageState();
        return issue;
      }
      if (
        (await login.isVisible()) ||
        new URL(page.url()).origin !== issue.origin ||
        /login|signin|authenticate|sso/i.test(new URL(page.url()).pathname)
      ) {
        await this.browser.step({
          action: "pauseForHuman",
          message: `请在当前 Jira 浏览器中完成登录，然后点击继续。登录后将核对 ${issue.key} 并恢复当前阶段。`,
        });
        this.browser.returnToMainPage();
        await this.browser.step({ action: "navigate", url: issue.url });
        continue;
      }
      throw new Error(
        `无法识别 Jira Ticket ${issue.key}。请检查页面和 issueKey 选择器后修复适配脚本`,
      );
    }
  }
}
