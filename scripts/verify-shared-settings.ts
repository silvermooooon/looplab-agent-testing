import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { setTimeout } from "node:timers/promises";
import { one, pool } from "../src/server/db.js";
import { saveLlmSettings } from "../src/server/platform-settings.js";

function localService(value: string | undefined, port: number) {
  const url = new URL(value || `http://127.0.0.1:${port}`);
  assert.ok(
    url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash,
    "共享配置验收仅接受本机 HTTP 实例",
  );
  return url.origin;
}

class Client {
  private cookie = "";
  constructor(readonly origin: string) {}

  async request(path: string, body?: unknown) {
    const response = await fetch(`${this.origin}/api${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(this.cookie ? { Cookie: this.cookie } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const cookie = response.headers.get("set-cookie");
    if (cookie) this.cookie = cookie.split(";")[0]!;
    assert.equal(response.status, 200, `${path} 请求失败`);
    return response.json() as Promise<any>;
  }

  async waitRun(id: string) {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const result = await this.request(`/runs/${id}`);
      if (result.run.events_complete) {
        assert.equal(result.run.status, "completed", `运行失败：${id}`);
        return result;
      }
      await setTimeout(200);
    }
    throw new Error(`运行未完成：${id}`);
  }
}

async function responsesFixture(
  label: string,
  stamp: string,
  firstTurnGate?: Promise<void>,
) {
  const model = `shared-settings-${label}-${stamp}`;
  const apiKey = `local-fixture-key-${label}-${stamp}`;
  const reply = `fixture-reply-${label}-${stamp}`;
  const callId = `call_${stamp}`;
  let requests = 0;
  let error = false;
  const server = createServer(async (request, response) => {
    try {
      assert.ok(request.method === "POST" && request.url === "/v1/responses");
      assert.ok(request.headers.authorization === `Bearer ${apiKey}`);
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert.ok(input.model === model && input.stream === true);
      requests++;
      const firstTurn = firstTurnGate && requests === 1;
      if (firstTurn) {
        assert.ok(input.tools.some((tool: any) => tool.name === "list_nodes"));
        // Publish the next DB settings while this run is waiting on its first turn.
        await firstTurnGate;
      } else if (firstTurnGate) {
        assert.ok(
          input.input.some(
            (item: any) =>
              item.type === "function_call_output" && item.call_id === callId,
          ),
        );
      }
      const output = firstTurn
        ? [
            {
              type: "function_call",
              id: `fc_${stamp}`,
              call_id: callId,
              name: "list_nodes",
              arguments: "{}",
              status: "completed",
            },
          ]
        : [
            {
              type: "message",
              id: `msg_${stamp}_${requests}`,
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: reply, annotations: [] }],
            },
          ];
      const event = {
        type: "response.completed",
        response: { output, status: "completed" },
      };
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(
        `event: response.completed\ndata: ${JSON.stringify(event)}\n\n`,
      );
    } catch {
      error = true;
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end('{"error":{"message":"Unexpected fixture request"}}');
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    settings: { baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey, model },
    reply,
    get requests() {
      return requests;
    },
    get error() {
      return error;
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}

const first = new Client(
  localService(process.env.SELF_TEST_SHARED_FIRST_URL, 4320),
);
const second = new Client(
  localService(process.env.SELF_TEST_SHARED_SECOND_URL, 4321),
);
assert.notEqual(first.origin, second.origin, "需要两个独立服务实例");
assert.ok(process.env.DATABASE_URL, "请显式设置隔离验收 DATABASE_URL");
const expectedDatabase = process.env.SELF_TEST_SHARED_DATABASE || "";
assert.match(
  expectedDatabase,
  /^looplab_shared_test(?:_[a-z0-9_]+)?$/,
  "请将 SELF_TEST_SHARED_DATABASE 指向专用的 looplab_shared_test 数据库",
);
const stamp = randomBytes(6).toString("hex");
let releaseFirst = () => {};
const gate = new Promise<void>((resolve) => {
  releaseFirst = resolve;
});
const fixtures: Awaited<ReturnType<typeof responsesFixture>>[] = [];

try {
  const connection = await one<{ database: string }>(
    "SELECT current_database() AS database",
  );
  assert.ok(
    connection?.database === expectedDatabase,
    "管理连接必须使用指定的隔离验收数据库",
  );
  const account = {
    name: "共享配置验收",
    email: `shared-settings-${stamp}@example.test`,
    password: randomBytes(24).toString("hex"),
  };
  const { user } = await first.request("/auth/register", account);
  const signedIn = await second.request("/auth/login", {
    email: account.email,
    password: account.password,
  });
  assert.equal(signedIn.user.id, user.id);
  const project = await first.request("/projects", {
    name: `共享配置 ${stamp}`,
  });
  const scope = `/projects/${project.id}`;
  assert.ok(
    await one("SELECT 1 FROM projects WHERE id=$1", [project.id]),
    "首个实例与管理连接必须使用同一数据库",
  );
  const secret = randomBytes(16).toString("hex");
  const environment = await first.request(`${scope}/environments`, {
    name: "跨实例环境",
    baseUrl: first.origin,
    secrets: { fixtureToken: secret },
  });
  const shared = await second.request(scope);
  assert.equal(shared.project.id, project.id);
  const sharedEnvironment = shared.environments.find(
    (item: any) => item.id === environment.id,
  );
  assert.deepEqual(sharedEnvironment?.secretKeys, ["fixtureToken"]);
  assert.ok(
    !JSON.stringify(shared).includes(secret),
    "HTTP 项目数据不应返回环境凭据",
  );
  console.log("PASS 两实例共享账号和项目，均可读取同一加密环境");

  const before = await responsesFixture("before", stamp, gate);
  fixtures.push(before);
  const after = await responsesFixture("after", stamp);
  fixtures.push(after);

  async function checkPublicSettings(
    expected: Awaited<ReturnType<typeof saveLlmSettings>>,
  ) {
    for (const client of [first, second]) {
      const health = await client.request("/health");
      assert.equal(health.database, true);
      assert.equal(health.modelConfigured, true);
      assert.equal(health.model, expected.model);
      assert.equal(health.llmRevision, expected.revision);
      const me = await client.request("/auth/me");
      assert.equal(me.user.id, user.id);
      assert.equal(me.model, expected.model);
      const login = await client.request("/auth/login", {
        email: account.email,
        password: account.password,
      });
      assert.equal(login.user.id, user.id);
      assert.equal(login.model, expected.model);
      const visible = JSON.stringify([health, me, login]);
      for (const { settings } of fixtures) {
        assert.ok(
          !visible.includes(settings.apiKey),
          "HTTP 元数据不应返回模型凭据",
        );
        assert.ok(
          !visible.includes(settings.baseUrl),
          "HTTP 元数据不应返回模型地址",
        );
      }
    }
  }

  async function startChat(client: Client) {
    const session = await client.request(`${scope}/chat/sessions`, {
      environmentId: environment.id,
      title: "共享配置动态更新验收",
    });
    const run = await client.request(`/chat/sessions/${session.id}/messages`, {
      clientId: randomUUID(),
      text: "请回复当前验收标记。",
    });
    return { sessionId: session.id as string, runId: run.runId as string };
  }

  async function completeChat(
    client: Client,
    { sessionId, runId }: Awaited<ReturnType<typeof startChat>>,
    marker: string,
    expected: Awaited<ReturnType<typeof saveLlmSettings>>,
  ) {
    const result = await client.waitRun(runId);
    const started = result.events.find(
      (item: any) => item.kind === "run_started",
    );
    assert.equal(started?.data.model, expected.model);
    assert.equal(started?.data.llmRevision, expected.revision);
    const { messages } = await client.request(`/chat/sessions/${sessionId}`);
    const reply = messages.find(
      (item: any) => item.run_id === runId && item.role === "assistant",
    );
    assert.ok(reply?.content.includes(marker), "对话应持久化实际模型回复");
    const visible = JSON.stringify([result, messages]);
    for (const { settings } of fixtures) {
      assert.ok(
        !visible.includes(settings.apiKey),
        "运行和对话不应返回模型凭据",
      );
    }
    return runId;
  }

  const oldSettings = await saveLlmSettings(before.settings);
  await checkPublicSettings(oldSettings);
  const running = await startChat(first);
  const deadline = Date.now() + 30_000;
  while (!before.requests && !before.error && Date.now() < deadline)
    await setTimeout(100);
  assert.equal(before.requests, 1, "应先收到使用旧配置的首轮请求");

  const newSettings = await saveLlmSettings(after.settings);
  assert.equal(newSettings.revision, oldSettings.revision + 1);
  await checkPublicSettings(newSettings);
  releaseFirst();
  const runIds = [
    await completeChat(first, running, before.reply, oldSettings),
  ];
  assert.equal(before.requests, 2, "运行中的工具续轮应继续使用旧配置");
  assert.equal(after.requests, 0);

  for (const client of [first, second])
    runIds.push(
      await completeChat(
        client,
        await startChat(client),
        after.reply,
        newSettings,
      ),
    );
  assert.equal(before.requests, 2);
  assert.equal(after.requests, 2, "两个实例的新任务都应使用新配置");
  assert.ok(fixtures.every((fixture) => !fixture.error));
  console.log(
    "PASS DB 更新后两个实例的新任务无需重启，进行中的工具续轮保持原配置",
  );

  await mkdir(".data", { recursive: true });
  await writeFile(
    ".data/shared-settings-result.json",
    JSON.stringify(
      {
        projectId: project.id,
        environmentId: environment.id,
        runIds,
        revisions: [oldSettings.revision, newSettings.revision],
        requests: [before.requests, after.requests],
      },
      null,
      2,
    ),
  );
} finally {
  releaseFirst();
  await Promise.all([
    ...fixtures.map((fixture) => fixture.close()),
    pool.end(),
  ]);
}
