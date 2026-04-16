import { describe, expect, it } from "vitest";
import { startMcpClients, shutdownAll } from "../mcp-client.js";
import { spawnMockMcpServer } from "@ageflow/testing";

describe("startMcpClients", () => {
  it("starts a client per McpServerConfig and lists tools", async () => {
    // For this test the mock server runs in-process via a stdio pipe.
    // spawnMockMcpServer gives us a (command, args) pair that spawns it.
    const handle = spawnMockMcpServer.asSubprocessCommand({
      tools: [{ name: "echo", description: "", inputSchema: {} }],
    });
    const clients = await startMcpClients([
      { name: "mock", command: handle.command, args: [...handle.args] },
    ]);
    expect(clients).toHaveLength(1);
    const tools = await clients[0]!.listTools();
    expect(tools.map((t) => t.name)).toEqual(["echo"]);
    await shutdownAll(clients);
  });

  it("throws McpServerStartFailedError when command is not on PATH", async () => {
    await expect(
      startMcpClients([{ name: "x", command: "/no/such/binary" }]),
    ).rejects.toThrow(/mcp_server_start_failed/i);
  });
});
