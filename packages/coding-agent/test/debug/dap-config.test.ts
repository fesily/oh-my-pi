import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as piUtils from "@oh-my-pi/pi-utils";
import {
	getAdapterConfigs,
	type LaunchAdapterSelection,
	resolveAdapter,
	selectAttachAdapter,
	selectLaunchAdapter,
} from "../../src/dap/config";
import type { DapResolvedAdapter } from "../../src/dap/types";
import { injectPluginDirRoots } from "../../src/discovery/helpers";

const tempDirs: string[] = [];
const ORIGINAL_OMP_PLUGIN_DIR = process.env.OMP_PLUGIN_DIR;
const ORIGINAL_OMP_MARKETPLACE_DIR = process.env.OMP_MARKETPLACE_DIR;

async function makeTempDir(prefix: string): Promise<string> {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempDirs.push(cwd);
	return cwd;
}

interface NestedGoProgram {
	moduleRoot: string;
	program: string;
}

async function writeExecutable(filePath: string): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\n");
	await fs.chmod(filePath, 0o755);
}

async function writeDlvOverride(cwd: string, command: string): Promise<void> {
	await fs.writeFile(path.join(cwd, "dap.json"), JSON.stringify({ adapters: { dlv: { command } } }));
}

async function setupMissingDlvProject(cwd: string): Promise<string> {
	const missingCommand = path.join(cwd, "tools", "missing-dlv");
	await fs.writeFile(path.join(cwd, "go.mod"), "module example.com/app\n\ngo 1.22\n");
	await writeExecutable(path.join(cwd, "bin", "gdb"));
	await writeDlvOverride(cwd, missingCommand);
	return missingCommand;
}

async function setupNestedGoProgram(cwd: string): Promise<NestedGoProgram> {
	const moduleRoot = path.join(cwd, "services", "api");
	const program = path.join(moduleRoot, "main.go");
	await fs.mkdir(moduleRoot, { recursive: true });
	await fs.writeFile(path.join(moduleRoot, "go.mod"), "module example.com/api\n\ngo 1.22\n");
	await fs.writeFile(program, "package main\n\nfunc main() {}\n");
	return { moduleRoot, program };
}

function requireSelectedAdapter(selection: LaunchAdapterSelection): DapResolvedAdapter {
	if (selection.kind !== "adapter") {
		throw new Error(`Expected an available adapter, received '${selection.kind}'`);
	}
	return selection.adapter;
}

function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
	const original = process.platform;
	Object.defineProperty(process, "platform", { value: platform, configurable: true });
	try {
		return fn();
	} finally {
		Object.defineProperty(process, "platform", { value: original, configurable: true });
	}
}

async function writeNativeAdapterOverrides(
	cwd: string,
	adapters: Record<string, string>,
): Promise<void> {
	const body: Record<string, { command: string; fileTypes?: string[]; rootMarkers?: string[] }> = {};
	for (const [name, command] of Object.entries(adapters)) {
		body[name] = { command };
	}
	// Preserve built-in fileTypes/languages via partial merge; only override command.
	await fs.writeFile(path.join(cwd, "dap.json"), JSON.stringify({ adapters: body }));
}

afterEach(async () => {
	vi.restoreAllMocks();
	if (ORIGINAL_OMP_PLUGIN_DIR === undefined) {
		delete process.env.OMP_PLUGIN_DIR;
	} else {
		process.env.OMP_PLUGIN_DIR = ORIGINAL_OMP_PLUGIN_DIR;
	}
	if (ORIGINAL_OMP_MARKETPLACE_DIR === undefined) {
		delete process.env.OMP_MARKETPLACE_DIR;
	} else {
		process.env.OMP_MARKETPLACE_DIR = ORIGINAL_OMP_MARKETPLACE_DIR;
	}
	await injectPluginDirRoots(os.homedir(), []);
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("DAP adapter configuration", () => {
	it("loads a custom adapter from dap.json and selects it by file extension", async () => {
		const cwd = await makeTempDir("omp-dap-config-json-");
		await fs.writeFile(path.join(cwd, "pom.xml"), "<project />\n");
		await fs.mkdir(path.join(cwd, "src"), { recursive: true });
		await fs.writeFile(path.join(cwd, "src", "Main.java"), "class Main {}\n");
		await fs.writeFile(
			path.join(cwd, "dap.json"),
			JSON.stringify({
				adapters: {
					"custom-jvm": {
						command: "bun",
						args: ["run", "debug-adapter"],
						languages: ["java", "kotlin"],
						fileTypes: [".java", ".kt"],
						rootMarkers: ["pom.xml", "build.gradle.kts"],
						launchDefaults: { request: "launch", mainClass: "" },
						attachDefaults: { request: "attach", host: "127.0.0.1" },
					},
				},
			}),
		);

		const adapter = resolveAdapter("custom-jvm", cwd);
		expect(adapter?.name).toBe("custom-jvm");
		expect(adapter?.command).toBe("bun");
		expect(adapter?.args).toEqual(["run", "debug-adapter"]);
		expect(adapter?.languages).toEqual(["java", "kotlin"]);
		expect(adapter?.fileTypes).toEqual([".java", ".kt"]);
		expect(adapter?.launchDefaults).toEqual({ request: "launch", mainClass: "" });
		expect(adapter?.attachDefaults).toEqual({ request: "attach", host: "127.0.0.1" });

		const selected = requireSelectedAdapter(selectLaunchAdapter(path.join("src", "Main.java"), cwd));
		expect(selected.name).toBe("custom-jvm");
	});

	it("merges partial user overrides over built-in adapters", async () => {
		const cwd = await makeTempDir("omp-dap-config-override-");
		await fs.writeFile(path.join(cwd, "script.py"), "print('hi')\n");
		await fs.writeFile(
			path.join(cwd, "dap.json"),
			JSON.stringify({
				adapters: {
					debugpy: {
						args: ["-m", "debugpy.adapter", "--log-dir", ".debugpy-logs"],
						launchDefaults: { justMyCode: false },
					},
				},
			}),
		);

		const config = getAdapterConfigs(cwd).debugpy;
		expect(config.command).toBe("python");
		expect(config.args).toEqual(["-m", "debugpy.adapter", "--log-dir", ".debugpy-logs"]);
		expect(config.fileTypes).toContain(".py");
		expect(config.launchDefaults).toMatchObject({ request: "launch", justMyCode: false });
	});

	it("loads adapter config from project config directories and YAML", async () => {
		const cwd = await makeTempDir("omp-dap-config-yaml-");
		await fs.mkdir(path.join(cwd, ".omp"), { recursive: true });
		await fs.writeFile(path.join(cwd, "build.gradle.kts"), "plugins {}\n");
		await fs.writeFile(path.join(cwd, "Main.kt"), "fun main() {}\n");
		await fs.writeFile(
			path.join(cwd, ".omp", "dap.yaml"),
			[
				"adapters:",
				"  yaml-kotlin:",
				"    command: bun",
				"    args:",
				"      - run",
				"      - kotlin-debug-adapter",
				"    languages:",
				"      - kotlin",
				"    fileTypes:",
				"      - .kt",
				"    rootMarkers:",
				"      - build.gradle.kts",
				"    launchDefaults:",
				"      request: launch",
				"      projectRoot: .",
				"",
			].join("\n"),
		);

		const selected = requireSelectedAdapter(selectLaunchAdapter("Main.kt", cwd));
		expect(selected.name).toBe("yaml-kotlin");
		expect(selected.launchDefaults).toEqual({ request: "launch", projectRoot: "." });
	});

	it("resolves relative adapter commands from the debug cwd", async () => {
		const cwd = await makeTempDir("omp-dap-config-relative-command-");
		const command = path.join(cwd, "tools", process.platform === "win32" ? "debug-adapter.cmd" : "debug-adapter");
		await fs.mkdir(path.dirname(command), { recursive: true });
		await fs.writeFile(command, "");
		await fs.chmod(command, 0o755);
		await fs.writeFile(
			path.join(cwd, "dap.json"),
			JSON.stringify({
				adapters: {
					relative: {
						command: process.platform === "win32" ? ".\\tools\\debug-adapter.cmd" : "./tools/debug-adapter",
						fileTypes: [".rel"],
					},
				},
			}),
		);

		const adapter = resolveAdapter("relative", cwd);
		expect(adapter?.command).toBe(
			process.platform === "win32" ? ".\\tools\\debug-adapter.cmd" : "./tools/debug-adapter",
		);
		expect(adapter?.resolvedCommand).toBe(command);
	});

	it("loads plugin DAP adapters from plugin config files", async () => {
		const cwd = await makeTempDir("omp-dap-config-plugin-");
		const pluginRoot = path.join(cwd, "plugins", "acme-debug");
		await fs.mkdir(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
		await fs.writeFile(path.join(cwd, "app.rb"), "puts 'hi'\n");
		await fs.writeFile(
			path.join(pluginRoot, ".claude-plugin", "plugin.json"),
			JSON.stringify({ name: "acme-debug" }),
		);
		await fs.writeFile(
			path.join(pluginRoot, ".dap.json"),
			JSON.stringify({
				adapters: {
					"acme-ruby": {
						command: "ruby-debug-adapter",
						fileTypes: [".rb"],
					},
				},
			}),
		);
		process.env.OMP_PLUGIN_DIR = path.join(cwd, "plugins");
		process.env.OMP_MARKETPLACE_DIR = path.join(cwd, "marketplaces");
		await injectPluginDirRoots(cwd, [pluginRoot], cwd);

		expect(getAdapterConfigs(cwd)["acme-ruby"]?.command).toBe("ruby-debug-adapter");
	});

	it("ignores invalid custom adapters without discarding valid configs", async () => {
		const cwd = await makeTempDir("omp-dap-config-invalid-");
		await fs.writeFile(
			path.join(cwd, "dap.json"),
			JSON.stringify({
				adapters: {
					"missing-command": {
						fileTypes: [".bad"],
					},
					valid: {
						command: "bun",
						fileTypes: [".ok"],
						rootMarkers: ["."],
					},
				},
			}),
		);

		const config = getAdapterConfigs(cwd);
		expect(config["missing-command"]).toBeUndefined();
		expect(config.valid?.command).toBe("bun");
	});

	it("reports missing dlv for Go source instead of falling back to a native debugger", async () => {
		const cwd = await makeTempDir("omp-dap-go-source-missing-");
		const missingCommand = await setupMissingDlvProject(cwd);
		const program = path.join(cwd, "main.go");
		await fs.writeFile(program, "package main\n\nfunc main() {}\n");

		const selection = selectLaunchAdapter(program, cwd);

		expect(selection).toEqual({ kind: "unavailable", adapterName: "dlv", command: missingCommand });
	});

	it("reports missing dlv for Go package directories instead of selecting a native debugger", async () => {
		const cwd = await makeTempDir("omp-dap-go-directory-missing-");
		const missingCommand = await setupMissingDlvProject(cwd);
		const program = path.join(cwd, "cmd", "server");
		await fs.mkdir(program, { recursive: true });

		const selection = selectLaunchAdapter(program, cwd, undefined, "directory");

		expect(selection).toEqual({ kind: "unavailable", adapterName: "dlv", command: missingCommand });
	});

	it("prefers a nested module adapter over cwd and PATH for inferred launches", async () => {
		const cwd = await makeTempDir("omp-dap-go-nested-local-");
		const { moduleRoot, program } = await setupNestedGoProgram(cwd);
		const nestedDlv = path.join(moduleRoot, "bin", "dlv");
		await writeExecutable(nestedDlv);
		await fs.writeFile(path.join(cwd, "go.mod"), "module example.com/repo\n\ngo 1.22\n");
		await writeExecutable(path.join(cwd, "bin", "dlv"));
		const whichSpy = vi.spyOn(piUtils, "$which").mockReturnValue(path.join(cwd, "global", "dlv"));

		const selected = requireSelectedAdapter(selectLaunchAdapter(program, cwd));

		expect(selected.resolvedCommand).toBe(nestedDlv);
		expect(whichSpy).not.toHaveBeenCalled();
	});

	it("uses a nested module adapter when dlv is requested explicitly", async () => {
		const cwd = await makeTempDir("omp-dap-go-nested-explicit-");
		const { moduleRoot, program } = await setupNestedGoProgram(cwd);
		const nestedDlv = path.join(moduleRoot, "bin", "dlv");
		await writeExecutable(nestedDlv);
		const whichSpy = vi.spyOn(piUtils, "$which").mockReturnValue(path.join(cwd, "global", "dlv"));

		const selected = requireSelectedAdapter(selectLaunchAdapter(program, cwd, "dlv"));

		expect(selected.resolvedCommand).toBe(nestedDlv);
		expect(whichSpy).not.toHaveBeenCalled();
	});

	it("prefers the session cwd adapter over PATH after a nested-root miss", async () => {
		const cwd = await makeTempDir("omp-dap-go-nested-cwd-");
		const { program } = await setupNestedGoProgram(cwd);
		const cwdDlv = path.join(cwd, "bin", "dlv");
		await fs.writeFile(path.join(cwd, "go.mod"), "module example.com/repo\n\ngo 1.22\n");
		await writeExecutable(cwdDlv);
		const whichSpy = vi.spyOn(piUtils, "$which").mockReturnValue(path.join(cwd, "global", "dlv"));

		const selected = requireSelectedAdapter(selectLaunchAdapter(program, cwd));

		expect(selected.resolvedCommand).toBe(cwdDlv);
		expect(whichSpy).not.toHaveBeenCalled();
	});

	it("resolves a local dlv for Go workspaces rooted by go.work", async () => {
		const cwd = await makeTempDir("omp-dap-go-work-");
		const program = path.join(cwd, "cmd", "worker");
		const localDlv = path.join(cwd, "bin", "dlv");
		await fs.writeFile(path.join(cwd, "go.work"), "go 1.22\n\nuse ./cmd/worker\n");
		await fs.mkdir(program, { recursive: true });
		await writeExecutable(localDlv);

		const selected = requireSelectedAdapter(selectLaunchAdapter(program, cwd, undefined, "directory"));

		expect(selected.resolvedCommand).toBe(localDlv);
	});

	it("re-resolves an adapter installed after an earlier miss", async () => {
		const cwd = await makeTempDir("omp-dap-go-fresh-");
		const program = path.join(cwd, "main.go");
		const command = path.join(cwd, "tools", process.platform === "win32" ? "dlv.cmd" : "dlv");
		await fs.writeFile(path.join(cwd, "go.mod"), "module example.com/cache\n\ngo 1.22\n");
		await fs.writeFile(program, "package main\n\nfunc main() {}\n");
		await writeDlvOverride(cwd, command);

		expect(selectLaunchAdapter(program, cwd)).toEqual({
			kind: "unavailable",
			adapterName: "dlv",
			command,
		});

		await writeExecutable(command);
		const selected = requireSelectedAdapter(selectLaunchAdapter(program, cwd));
		expect(selected.resolvedCommand).toBe(command);
	});

	it("registers built-in dap-dbgeng with Windows-oriented defaults", () => {
		const dbgeng = getAdapterConfigs()["dap-dbgeng"];
		expect(dbgeng).toBeDefined();
		expect(dbgeng?.command).toBe("dap-dbgeng");
		expect(dbgeng?.args ?? []).toEqual([]);
		expect(dbgeng?.languages).toEqual(["c", "cpp"]);
		expect(dbgeng?.fileTypes).toEqual(
			expect.arrayContaining([".c", ".cpp", ".exe", ".h", ".hpp"]),
		);
		expect(dbgeng?.rootMarkers).toEqual(
			expect.arrayContaining(["CMakeLists.txt", "compile_commands.json", "*.sln", "*.vcxproj"]),
		);
		expect(dbgeng?.launchDefaults).toMatchObject({
			request: "launch",
			stopAtEntry: true,
		});
		expect(dbgeng?.launchDefaults).not.toHaveProperty("stopOnEntry");
		expect(dbgeng?.attachDefaults).toMatchObject({ request: "attach" });
	});

	it("prefers dap-dbgeng for .exe launch on win32 when available", async () => {
		const cwd = await makeTempDir("omp-dap-dbgeng-exe-");
		const dbgengCmd = path.join(cwd, "tools", process.platform === "win32" ? "dap-dbgeng.cmd" : "dap-dbgeng");
		const gdbCmd = path.join(cwd, "tools", process.platform === "win32" ? "gdb.cmd" : "gdb");
		await writeExecutable(dbgengCmd);
		await writeExecutable(gdbCmd);
		await writeNativeAdapterOverrides(cwd, {
			"dap-dbgeng": dbgengCmd,
			gdb: gdbCmd,
			"lldb-dap": path.join(cwd, "tools", "missing-lldb"),
		});
		const program = path.join(cwd, "app.exe");
		await fs.writeFile(program, "");

		const selected = withPlatform("win32", () =>
			requireSelectedAdapter(selectLaunchAdapter(program, cwd)),
		);
		expect(selected.name).toBe("dap-dbgeng");
		expect(selected.resolvedCommand).toBe(dbgengCmd);
	});

	it("does not force dap-dbgeng ahead of gdb for extensionless binaries on non-win32", async () => {
		const cwd = await makeTempDir("omp-dap-dbgeng-nonwin-");
		const dbgengCmd = path.join(cwd, "tools", process.platform === "win32" ? "dap-dbgeng.cmd" : "dap-dbgeng");
		const gdbCmd = path.join(cwd, "tools", process.platform === "win32" ? "gdb.cmd" : "gdb");
		await writeExecutable(dbgengCmd);
		await writeExecutable(gdbCmd);
		await writeNativeAdapterOverrides(cwd, {
			"dap-dbgeng": dbgengCmd,
			gdb: gdbCmd,
			"lldb-dap": path.join(cwd, "tools", "missing-lldb"),
		});
		const program = path.join(cwd, "a.out");
		await writeExecutable(program);

		const selected = withPlatform("linux", () =>
			requireSelectedAdapter(selectLaunchAdapter(program, cwd)),
		);
		// Prefer gdb over dap-dbgeng when both available on non-win32; do not force dbgeng first.
		expect(selected.name).not.toBe("dap-dbgeng");
		expect(selected.name).toBe("gdb");
	});

	it("prefers dap-dbgeng for PID attach on win32 when no port is given", async () => {
		const cwd = await makeTempDir("omp-dap-dbgeng-attach-");
		const dbgengCmd = path.join(cwd, "tools", process.platform === "win32" ? "dap-dbgeng.cmd" : "dap-dbgeng");
		const gdbCmd = path.join(cwd, "tools", process.platform === "win32" ? "gdb.cmd" : "gdb");
		await writeExecutable(dbgengCmd);
		await writeExecutable(gdbCmd);
		await writeNativeAdapterOverrides(cwd, {
			"dap-dbgeng": dbgengCmd,
			gdb: gdbCmd,
		});

		const selected = withPlatform("win32", () => selectAttachAdapter(cwd));
		expect(selected?.name).toBe("dap-dbgeng");
	});

	it("keeps debugpy preference for attach when a port is provided on win32", async () => {
		const cwd = await makeTempDir("omp-dap-dbgeng-attach-port-");
		const dbgengCmd = path.join(cwd, "tools", process.platform === "win32" ? "dap-dbgeng.cmd" : "dap-dbgeng");
		const debugpyCmd = path.join(cwd, "tools", process.platform === "win32" ? "python.cmd" : "python");
		await writeExecutable(dbgengCmd);
		await writeExecutable(debugpyCmd);
		await writeNativeAdapterOverrides(cwd, {
			"dap-dbgeng": dbgengCmd,
			debugpy: debugpyCmd,
		});

		const selected = withPlatform("win32", () => selectAttachAdapter(cwd, undefined, 5678));
		expect(selected?.name).toBe("debugpy");
	});

	it("reports explicit dap-dbgeng unavailable instead of falling back", async () => {
		const cwd = await makeTempDir("omp-dap-dbgeng-missing-");
		const missing = path.join(cwd, "tools", "dap-dbgeng-missing");
		await writeNativeAdapterOverrides(cwd, { "dap-dbgeng": missing });
		const program = path.join(cwd, "app.exe");
		await fs.writeFile(program, "");

		const selection = selectLaunchAdapter(program, cwd, "dap-dbgeng");
		expect(selection).toEqual({
			kind: "unavailable",
			adapterName: "dap-dbgeng",
			command: missing,
		});
	});
});
