import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cp from "node:child_process";
import jitiFactory from "jiti";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const pluginSdkStubPath = path.resolve(testDir, "helpers", "openclaw-plugin-sdk-stub.mjs");
const jiti = jitiFactory(import.meta.url, {
  interopDefault: true,
  cache: false,
  alias: {
    "openclaw/plugin-sdk": pluginSdkStubPath,
  },
});

const pluginModule = jiti("../index.ts");
const memoryLanceDBProPlugin = pluginModule.default || pluginModule;

function createPluginApiHarness({ pluginConfig, resolveRoot, spawnedSessions }) {
  const hooks = new Map();
  const eventListeners = new Map();
  const logs = [];

  const api = {
    pluginConfig,
    resolvePath(target) {
      return path.join(resolveRoot, target);
    },
    logger: {
      info(message) { logs.push(["info", String(message)]); },
      warn(message) { logs.push(["warn", String(message)]); },
      debug(message) { logs.push(["debug", String(message)]); },
      error(message) { logs.push(["error", String(message)]); },
    },
    registerTool() {},
    registerCli() {},
    registerService() {},
    on(eventName, handler) {
      const list = eventListeners.get(eventName) || [];
      list.push(handler);
      eventListeners.set(eventName, list);
    },
    registerHook(eventName, handler, opts) {
      const list = hooks.get(eventName) || [];
      list.push({ handler, opts });
      hooks.set(eventName, list);
    },
    callTool(name, params) {
      return Promise.resolve({});
    },
    runtime: {
      agent: {
        resolveAgentWorkspaceDir(id) {
          return Promise.resolve(`/workspace/${id}`);
        }
      }
    }
  };

  return { api, hooks, eventListeners, logs, spawnedSessions };
}

describe("background reflection", () => {
  let workDir;
  let globalSpawnedSessions;

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), "bg-reflection-test-"));
    globalSpawnedSessions = [];
    mock.method(cp, "spawn", (cmd, args, opts) => {
      const idxAgent = args.indexOf("--agent");
      const idxMsg = args.indexOf("--message");
      globalSpawnedSessions.push({
        agentId: idxAgent > -1 ? args[idxAgent + 1] : "",
        prompt: idxMsg > -1 ? args[idxMsg + 1] : "",
        isBackground: true,
        model: opts?.env?.OPENCLAW_MODEL,
        parentSessionId: opts?.env?.OPENCLAW_PARENT_SESSION_ID
      });
      return {
        unref: () => {},
        stdout: { setEncoding: () => {}, on: () => {} },
        stderr: { setEncoding: () => {}, on: () => {} },
        once: (event, cb) => {
          if (event === "close") {
            // Emulate process finishing immediately so promises resolve
            Promise.resolve().then(() => cb(0, null));
          }
        },
        on: () => {},
        kill: () => {}
      };
    });
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
    mock.restoreAll();
  });

  it("triggers background reflection on 'reset' with configured agentId", async () => {
    const pluginConfig = {
      embedding: { apiKey: "test" },
      selfImprovement: {
        enabled: true,
        reflectionAgentId: "reflection-bot",
        reflectionPrompt: "Custom reflect prompt"
      }
    };
    const harness = createPluginApiHarness({ pluginConfig, resolveRoot: workDir, spawnedSessions: globalSpawnedSessions });
    memoryLanceDBProPlugin.register(harness.api);

    const resetHooks = harness.hooks.get("command:reset") || [];
    const handler = resetHooks[0].handler;

    const event = {
      action: "reset",
      sessionKey: "agent:user:session:123",
      sessionId: "parent-456",
      messages: []
    };

    await handler(event);

    assert.equal(harness.spawnedSessions.length, 1);
    assert.equal(harness.spawnedSessions[0].agentId, "reflection-bot");
    assert.equal(harness.spawnedSessions[0].prompt, "Custom reflect prompt");
    assert.equal(harness.spawnedSessions[0].isBackground, true);
    assert.equal(harness.spawnedSessions[0].parentSessionId, "parent-456");
  });

  it("supports reflectionAgentId='current' to use the same agent that was reset", async () => {
    const pluginConfig = {
      embedding: { apiKey: "test" },
      selfImprovement: {
        enabled: true,
        reflectionAgentId: "current"
      }
    };
    const harness = createPluginApiHarness({ pluginConfig, resolveRoot: workDir, spawnedSessions: globalSpawnedSessions });
    memoryLanceDBProPlugin.register(harness.api);

    const resetHooks = harness.hooks.get("command:reset") || [];
    const handler = resetHooks[0].handler;

    const event = {
      action: "reset",
      sessionKey: "agent:main-agent:session:123",
      context: {
        sessionEntry: {
          agentId: "main-agent"
        }
      },
      messages: []
    };

    await handler(event);

    assert.equal(harness.spawnedSessions.length, 1);
    assert.equal(harness.spawnedSessions[0].agentId, "main-agent");
  });

  it("applies model override when reflectionModel is configured", async () => {
    const pluginConfig = {
      embedding: { apiKey: "test" },
      selfImprovement: {
        enabled: true,
        reflectionAgentId: "reflection-bot",
        reflectionModel: "gpt-4o"
      }
    };
    const harness = createPluginApiHarness({ pluginConfig, resolveRoot: workDir, spawnedSessions: globalSpawnedSessions });
    memoryLanceDBProPlugin.register(harness.api);

    const resetHooks = harness.hooks.get("command:reset") || [];
    const handler = resetHooks[0].handler;

    const event = {
      action: "reset",
      sessionKey: "agent:user:session:123",
      messages: []
    };

    await handler(event);

    assert.equal(harness.spawnedSessions.length, 1);
    assert.equal(harness.spawnedSessions[0].model, "gpt-4o");
  });

  it("triggers on 'new' action as well", async () => {
    const pluginConfig = {
      embedding: { apiKey: "test" },
      selfImprovement: {
        enabled: true,
        reflectionAgentId: "reflection-bot"
      }
    };
    const harness = createPluginApiHarness({ pluginConfig, resolveRoot: workDir, spawnedSessions: globalSpawnedSessions });
    memoryLanceDBProPlugin.register(harness.api);

    const newHooks = harness.hooks.get("command:new") || [];
    const handler = newHooks[0].handler;

    const event = {
      action: "new",
      sessionKey: "agent:user:session:123",
      messages: []
    };

    await handler(event);

    assert.equal(harness.spawnedSessions.length, 1);
    assert.equal(harness.spawnedSessions[0].agentId, "reflection-bot");
  });

  it("skips background reflection if reflectionAgentId is not set (falls back to manual note)", async () => {
    const pluginConfig = {
      embedding: { apiKey: "test" },
      selfImprovement: {
        enabled: true,
        beforeResetNote: true
      }
    };
    const harness = createPluginApiHarness({ pluginConfig, resolveRoot: workDir, spawnedSessions: globalSpawnedSessions });
    memoryLanceDBProPlugin.register(harness.api);

    const resetHooks = harness.hooks.get("command:reset") || [];
    const handler = resetHooks[0].handler;

    const event = {
      action: "reset",
      sessionKey: "agent:user:session:123",
      messages: []
    };

    await handler(event);

    assert.equal(harness.spawnedSessions.length, 0);
    assert.ok(event.messages.length > 0, "Should have injected manual note");
  });

  it("triggers background reflection on 'session_end' for subagents with reflectionAgentId='current'", async () => {
    const pluginConfig = {
      embedding: { apiKey: "test" },
      selfImprovement: {
        enabled: true,
        reflectionAgentId: "current"
      }
    };
    const harness = createPluginApiHarness({ pluginConfig, resolveRoot: workDir, spawnedSessions: globalSpawnedSessions });
    memoryLanceDBProPlugin.register(harness.api);

    const sessionEndHandlers = harness.eventListeners.get("session_end") || [];
    assert.ok(sessionEndHandlers.length > 0, "session_end handler should be registered");

    for (const handler of sessionEndHandlers) {
      await handler({
        sessionKey: "agent:researcher:session:789",
        sessionId: "subagent-123"
      }, {
        agentId: "researcher"
      });
    }

    assert.equal(harness.spawnedSessions.length, 1);
    assert.equal(harness.spawnedSessions[0].agentId, "researcher");
    assert.equal(harness.spawnedSessions[0].isBackground, true);
    assert.equal(harness.spawnedSessions[0].parentSessionId, "subagent-123");
  });

  it("skips 'session_end' background reflection if it is a reflection session itself", async () => {
    const pluginConfig = {
      embedding: { apiKey: "test" },
      selfImprovement: {
        enabled: true,
        reflectionAgentId: "current"
      }
    };
    const harness = createPluginApiHarness({ pluginConfig, resolveRoot: workDir, spawnedSessions: globalSpawnedSessions });
    memoryLanceDBProPlugin.register(harness.api);

    const sessionEndHandlers = harness.eventListeners.get("session_end") || [];
    
    for (const handler of sessionEndHandlers) {
      await handler({
        sessionKey: "agent:reflection-bot:reflection:456",
        sessionId: "memory-reflection-cli-xxx"
      }, {
        agentId: "reflection-bot"
      });
    }

    assert.equal(harness.spawnedSessions.length, 0, "Should not spawn a reflection for a reflection session");
  });
});
