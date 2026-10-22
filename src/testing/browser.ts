import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import { expect } from "playwright/test";
import { config } from "../server/config.js";
import {
  interpolate,
  type Step,
  type Variables,
  type NodeSpec,
} from "./spec.js";
export class BrowserSession {
  private browser?: Browser;
  private context?: BrowserContext;
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
  async step(step: Step, params: Record<string, string> = {}) {
    this.signal.throwIfAborted();
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
    if (step.action === "screenshot")
      return { artifactId: await this.capture(resolve(step.name)) };
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
          timeout: 20000,
        });
        break;
      case "assertVisible":
        await expect(locator).toBeVisible();
        break;
      case "waitFor":
        await locator.waitFor({ state: "visible" });
        break;
      case "extractText":
        this.outputs[step.output] = await locator.innerText();
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
        await onStep(
          step,
          index,
          "failed",
          error instanceof Error ? error.message : String(error),
        );
        throw error;
      }
    }
  }
}
