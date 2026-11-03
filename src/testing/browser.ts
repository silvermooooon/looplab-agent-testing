import {
  chromium,
  type Browser,
  type BrowserContext,
  type Dialog,
  type Page,
  type Response,
} from "playwright";
import { expect } from "playwright/test";
import { config } from "../server/config.js";
import {
  interpolate,
  testFileText,
  type Step,
  type Variables,
  type NodeSpec,
} from "./spec.js";
export interface InterventionInfo {
  message: string;
  trigger: "manual" | "element" | "dialog" | "response";
  dialog?: { type: string; message: string; defaultValue: string };
}
export interface ManualAction {
  type: string;
  x?: number;
  y?: number;
  text?: string;
  key?: string;
  deltaY?: number;
}
export interface TestFile {
  id: string;
  name: string;
  mime_type: string;
  sha256: string;
  data: Buffer;
}
type Watcher = { stop: () => void; check?: () => Promise<void> };

export class BrowserSession {
  private browser?: Browser;
  private context?: BrowserContext;
  private watchers = new Set<Watcher>();
  private handoffs: Promise<void> = Promise.resolve();
  private dialog?: Dialog;
  private dialogClosed?: Promise<void>;
  private resolveDialog?: () => void;
  private fileOutputs = new Set<string>();
  page!: Page;
  readonly outputs: Record<string, string> = {};
  constructor(
    readonly baseUrl: string,
    readonly secrets: Record<string, string>,
    readonly variables: Record<string, string>,
    readonly artifact: (
      name: string,
      data: Buffer,
      mime?: string,
    ) => Promise<string>,
    readonly signal: AbortSignal,
    readonly onIntervention?: (info: InterventionInfo) => Promise<void>,
    readonly loadTestFile?: (id: string) => Promise<TestFile>,
    readonly onTestFileUsed?: () => void,
  ) {}
  async open() {
    this.signal.throwIfAborted();
    this.browser = await chromium.launch({
      headless: true,
      channel: config.browserChannel,
    });
    this.context = await this.browser.newContext({
      viewport: { width: 1440, height: 960 },
    });
    this.context.setDefaultTimeout(12000);
    await this.context.route("**/*", (route) => {
      const request = route.request();
      if (
        request.isNavigationRequest() &&
        new URL(request.url()).origin !== new URL(this.baseUrl).origin
      )
        return route.abort();
      return route.continue();
    });
    this.page = await this.context.newPage();
    this.signal.addEventListener("abort", this.abort, { once: true });
    if (this.signal.aborted) {
      await this.close();
      this.signal.throwIfAborted();
    }
    await this.page.goto(this.baseUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
  }
  private abort = () => {
    void this.browser?.close().catch(() => {});
  };
  async close() {
    this.signal.removeEventListener("abort", this.abort);
    this.clearWatchers();
    await this.browser?.close().catch(() => {});
  }
  async inspect() {
    this.signal.throwIfAborted();
    return {
      url: this.page.url(),
      title: await this.page.title(),
      accessibility: (await this.page.locator("body").ariaSnapshot()).slice(
        0,
        24000,
      ),
      elements: await this.page
        .locator("input,textarea,button,a,select,[data-testid]")
        .evaluateAll((elements) =>
          elements.slice(0, 70).map((e) => ({
            tag: e.tagName.toLowerCase(),
            id: e.id,
            testId: e.getAttribute("data-testid"),
            name: e.getAttribute("name"),
            type: e.getAttribute("type"),
            placeholder: e.getAttribute("placeholder"),
            ariaLabel: e.getAttribute("aria-label"),
            text: e.textContent?.slice(0, 100),
          })),
        ),
    };
  }
  async capture(name: string) {
    // Mask credential fields rather than collecting filled password screenshots.
    const data = await this.page.screenshot({
      fullPage: true,
      mask: [this.page.locator("input[type=password]")],
    });
    return this.artifact(name, data);
  }
  manualDialog() {
    if (!this.dialog) return undefined;
    return {
      type: this.dialog.type(),
      message: this.dialog.message(),
      defaultValue: this.dialog.defaultValue(),
    };
  }
  async manualScreenshot() {
    if (this.dialog)
      throw new Error("原生浏览器弹框等待处理，请先确认或取消弹框");
    return this.page.screenshot({
      fullPage: false,
      mask: [this.page.locator("input[type=password]")],
      timeout: 3000,
    });
  }
  async manualAction(action: ManualAction) {
    this.signal.throwIfAborted();
    switch (action.type) {
      case "click":
        if (action.x === undefined || action.y === undefined)
          throw new Error("Click requires x and y");
        await this.page.mouse.click(action.x, action.y);
        return;
      case "type":
        if (action.text === undefined) throw new Error("Type requires text");
        await this.page.keyboard.insertText(action.text);
        return;
      case "press":
        if (!action.key) throw new Error("Press requires key");
        await this.page.keyboard.press(action.key);
        return;
      case "scroll":
        await this.page.mouse.wheel(0, action.deltaY ?? 0);
        return;
      case "dialogAccept":
      case "dialogDismiss": {
        const dialog = this.dialog;
        if (!dialog) throw new Error("没有等待处理的原生浏览器弹框");
        if (action.type === "dialogAccept") await dialog.accept(action.text);
        else await dialog.dismiss();
        if (this.dialog === dialog) {
          this.dialog = undefined;
          this.resolveDialog?.();
          this.resolveDialog = undefined;
          this.dialogClosed = undefined;
        }
        return;
      }
      default:
        throw new Error(`Unsupported manual action: ${action.type}`);
    }
  }
  private async abortable<T>(promise: Promise<T>): Promise<T> {
    this.signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
      const aborted = () => reject(this.signal.reason ?? new Error("Aborted"));
      this.signal.addEventListener("abort", aborted, { once: true });
      promise
        .then(resolve, reject)
        .finally(() => this.signal.removeEventListener("abort", aborted));
    });
  }
  private requestIntervention(info: InterventionInfo, dialog?: Dialog) {
    if (!this.onIntervention)
      throw new Error(
        "This browser session does not support human intervention",
      );
    const handoff = this.handoffs.then(async () => {
      if (dialog && this.dialog !== dialog) return;
      await this.abortable(this.onIntervention!(info));
      if (dialog && this.dialog === dialog && this.dialogClosed)
        await this.abortable(this.dialogClosed);
    });
    this.handoffs = handoff;
    void handoff.catch(() => {});
    return handoff;
  }
  private async waitForInterventions() {
    let waiting: Promise<void>;
    do {
      waiting = this.handoffs;
      await this.abortable(waiting);
    } while (waiting !== this.handoffs);
  }
  private clearWatchers() {
    for (const watcher of this.watchers) watcher.stop();
  }
  private async checkWatchers() {
    await Promise.all([...this.watchers].map((watcher) => watcher.check?.()));
  }
  async finishWatchers() {
    await this.waitForInterventions();
    await this.checkWatchers();
    await this.waitForInterventions();
    this.clearWatchers();
  }
  private async watchElement(selector: string, message: string) {
    if (!this.onIntervention)
      throw new Error(
        "This browser session does not support human intervention",
      );
    const locator = this.page
      .locator(selector)
      .filter({ visible: true })
      .first();
    let active = true;
    let visible = false;
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let checking: Promise<void> | undefined;
    const watcher: Watcher = {
      stop: () => {
        active = false;
        if (timer) clearTimeout(timer);
        this.watchers.delete(watcher);
      },
      check: () => {
        if (!active) return Promise.resolve();
        if (checking) return checking;
        checking = (async () => {
          const isVisible = await locator.isVisible();
          if (active && isVisible && !visible && !pending) {
            pending = true;
            void this.requestIntervention({ message, trigger: "element" }).then(
              () => {
                pending = false;
              },
              () => {
                pending = false;
              },
            );
          }
          visible = isVisible;
        })().finally(() => {
          checking = undefined;
        });
        return checking;
      },
    };
    this.watchers.add(watcher);
    const poll = async () => {
      try {
        await watcher.check!();
      } catch {
        // Navigation can temporarily remove the execution context; retry on the new page.
      }
      if (active) timer = setTimeout(poll, 250);
    };
    await watcher.check!();
    if (active) timer = setTimeout(poll, 250);
  }
  private watchDialog(message: string) {
    if (!this.onIntervention)
      throw new Error(
        "This browser session does not support human intervention",
      );
    let active = true;
    let pending = false;
    const schedule = () => {
      const dialog = this.dialog;
      if (!active || !dialog || pending) return;
      pending = true;
      void this.requestIntervention(
        { message, trigger: "dialog", dialog: this.manualDialog() },
        dialog,
      ).then(
        () => {
          pending = false;
          schedule();
        },
        () => {
          pending = false;
        },
      );
    };
    const handler = (dialog: Dialog) => {
      if (this.dialog === dialog) return;
      this.resolveDialog?.();
      this.dialog = dialog;
      this.dialogClosed = new Promise<void>((resolve) => {
        this.resolveDialog = resolve;
      });
      schedule();
    };
    const watcher: Watcher = {
      stop: () => {
        active = false;
        this.page.off("dialog", handler);
        this.watchers.delete(watcher);
      },
    };
    this.watchers.add(watcher);
    this.page.on("dialog", handler);
  }
  private watchResponse(url: string, message: string) {
    if (!this.onIntervention)
      throw new Error(
        "This browser session does not support human intervention",
      );
    let pending = false;
    const handler = (response: Response) => {
      if (!response.url().includes(url) || pending) return;
      pending = true;
      void this.requestIntervention({ message, trigger: "response" }).then(
        () => {
          pending = false;
        },
        () => {
          pending = false;
        },
      );
    };
    const watcher: Watcher = {
      stop: () => {
        this.page.off("response", handler);
        this.watchers.delete(watcher);
      },
    };
    this.watchers.add(watcher);
    this.page.on("response", handler);
  }
  async step(step: Step, params: Record<string, string> = {}) {
    this.signal.throwIfAborted();
    await this.waitForInterventions();
    await this.checkWatchers();
    await this.waitForInterventions();
    let result: unknown;
    let failure: unknown;
    try {
      result = await this.executeStep(step, params);
    } catch (error) {
      failure = error;
    }
    await this.waitForInterventions();
    if (failure) throw failure;
    await this.checkWatchers();
    await this.waitForInterventions();
    return result;
  }
  private async executeStep(step: Step, params: Record<string, string>) {
    const context: Variables = {
      baseUrl: this.baseUrl,
      param: params,
      secret: this.secrets,
      var: this.variables,
      output: this.outputs,
    };
    const resolve = (s: string) => interpolate(s, context);
    if (step.action === "navigate") {
      const url = new URL(resolve(step.url), this.baseUrl);
      if (url.origin !== new URL(this.baseUrl).origin)
        throw new Error(
          "Navigation outside configured environment origin is not allowed",
        );
      await this.page.goto(url.href, { waitUntil: "domcontentloaded" });
      return;
    }
    if (step.action === "reload") {
      await this.page.reload({ waitUntil: "domcontentloaded" });
      return;
    }
    if (step.action === "screenshot")
      return { artifactId: await this.capture(resolve(step.name)) };
    if (step.action === "pauseForHuman") {
      this.requestIntervention({
        message: resolve(step.message),
        trigger: "manual",
      });
      return;
    }
    if (step.action === "watchElement") {
      await this.watchElement(resolve(step.selector), resolve(step.message));
      return;
    }
    if (step.action === "watchDialog") {
      this.watchDialog(resolve(step.message));
      return;
    }
    if (step.action === "watchResponse") {
      this.watchResponse(resolve(step.url), resolve(step.message));
      return;
    }
    if (step.action === "waitForResponse") {
      const url = resolve(step.url);
      await this.page.waitForResponse(
        (response) => response.url().includes(url),
        {
          timeout: step.timeoutMs,
        },
      );
      return;
    }
    if (step.action === "clearWatchers") {
      this.clearWatchers();
      return;
    }
    if (step.action === "uploadFile" || step.action === "readFile") {
      if (!this.loadTestFile) throw new Error("当前执行环境不支持测试文件库");
      const file = await this.loadTestFile(resolve(step.fileId));
      if (step.action === "uploadFile") {
        await this.page.locator(resolve(step.selector)).setInputFiles({
          name: file.name,
          mimeType: file.mime_type,
          buffer: file.data,
        });
        this.onTestFileUsed?.();
      } else {
        const text = testFileText(file.data);
        this.onTestFileUsed?.();
        this.outputs[step.output] = text;
        this.fileOutputs.add(step.output);
      }
      return;
    }
    const locator = this.page.locator(resolve(step.selector));
    switch (step.action) {
      case "fill":
        await locator.fill(resolve(step.value));
        break;
      case "click":
        await locator.click();
        break;
      case "press":
        await locator.press(resolve(step.key));
        break;
      case "assertText":
        await expect(locator).toContainText(resolve(step.text), {
          timeout: step.timeoutMs ?? 20000,
        });
        break;
      case "assertVisible":
        await expect(locator).toBeVisible(
          step.timeoutMs ? { timeout: step.timeoutMs } : undefined,
        );
        break;
      case "waitFor":
        await locator.waitFor({ state: "visible", timeout: step.timeoutMs });
        break;
      case "waitForHidden":
        await locator.waitFor({ state: "hidden", timeout: step.timeoutMs });
        break;
      case "extractText":
        this.outputs[step.output] = await locator.innerText();
        this.fileOutputs.delete(step.output);
        return { output: step.output, value: this.outputs[step.output] };
    }
  }
  async node(
    spec: NodeSpec,
    params: Record<string, string>,
    onStep: (
      step: Step,
      index: number,
      state: "start" | "passed" | "failed",
      error?: string,
    ) => Promise<void>,
  ) {
    for (const name of spec.inputs)
      if (!Object.hasOwn(params, name))
        throw new Error(`Missing node input: ${name}`);
    for (const [index, step] of spec.steps.entries()) {
      await onStep(step, index, "start");
      try {
        await this.step(step, params);
        await onStep(step, index, "passed");
      } catch (error) {
        const encoded = JSON.stringify(step);
        const usedParams = [
          ...encoded.matchAll(/\{\{\s*param\.([a-zA-Z][\w]*)\s*\}\}/g),
        ].map((match) => match[1]!);
        const usesFileText = [...this.fileOutputs].some((key) => {
          const reference = new RegExp(`\\{\\{\\s*output\\.${key}\\s*\\}\\}`);
          return (
            reference.test(encoded) ||
            usedParams.some((param) => reference.test(params[param] ?? ""))
          );
        });
        const message = usesFileText
          ? `步骤 ${step.action} 失败（测试文件内容已隐藏）`
          : error instanceof Error
            ? error.message
            : String(error);
        await onStep(step, index, "failed", message);
        if (usesFileText) throw new Error(message);
        throw error;
      }
    }
  }
}
