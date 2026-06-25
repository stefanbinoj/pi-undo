import { spawn, type ChildProcess } from "node:child_process";
import { platform } from "node:os";

type Runner = {
	readonly name: string;
	start(): void;
	pulse(): void;
	stop(): void;
};


function spawnDetached(command: string, args: string[]): ChildProcess {
	const child = spawn(command, args, {
		stdio: "ignore",
		detached: false,
	});
	child.on("error", () => {
		// Keep-awake should never crash Pi if the host command is unavailable.
	});
	return child;
}

function stopProcess(child: ChildProcess | undefined): void {
	if (!child || child.killed) return;
	child.kill();
}

function createMacRunner(): Runner {
	let child: ChildProcess | undefined;

	return {
		name: "caffeinate",
		start() {
			if (child && !child.killed) return;
			child = spawnDetached("caffeinate", ["-dimsu"]);
		},
		pulse() {
			if (!child || child.killed || child.exitCode !== null) {
				child = spawnDetached("caffeinate", ["-dimsu"]);
			}
		},
		stop() {
			stopProcess(child);
			child = undefined;
		},
	};
}

function createWindowsRunner(): Runner {
	let child: ChildProcess | undefined;

	const script = [
		"Add-Type -Name NativeMethods -Namespace Win32 -MemberDefinition '[System.Runtime.InteropServices.DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint esFlags);';",
		"while ($true) {",
		"  [void][Win32.NativeMethods]::SetThreadExecutionState(0x80000003);",
		"  Start-Sleep -Seconds 60;",
		"}",
	].join(" ");

	return {
		name: "SetThreadExecutionState",
		start() {
			if (child && !child.killed) return;
			child = spawnDetached("powershell.exe", [
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				script,
			]);
		},
		pulse() {
			if (!child || child.killed || child.exitCode !== null) {
				this.start();
			}
		},
		stop() {
			stopProcess(child);
			child = undefined;
			spawnDetached("powershell.exe", [
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				"Add-Type -Name NativeMethods -Namespace Win32 -MemberDefinition '[System.Runtime.InteropServices.DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint esFlags);'; [void][Win32.NativeMethods]::SetThreadExecutionState(0x80000000)",
			]);
		},
	};
}

function createLinuxRunner(): Runner {
	let child: ChildProcess | undefined;

	return {
		name: "systemd-inhibit",
		start() {
			if (child && !child.killed) return;
			child = spawnDetached("systemd-inhibit", [
				"--what=sleep:idle",
				"--why=Pi agent is running",
				"sleep",
				"infinity",
			]);
		},
		pulse() {
			if (!child || child.killed || child.exitCode !== null) {
				this.start();
			}
			spawnDetached("xdg-screensaver", ["reset"]);
		},
		stop() {
			stopProcess(child);
			child = undefined;
		},
	};
}

function createRunner(): Runner {
	switch (platform()) {
		case "darwin":
			return createMacRunner();
		case "win32":
			return createWindowsRunner();
		case "linux":
			return createLinuxRunner();
		default:
			return {
				name: "noop",
				start() {},
				pulse() {},
				stop() {},
			};
	}
}

export function createKeepAwakeController(): {
	start(): void;
	stop(): void;
} {
	const runner = createRunner();
	const heartbeatMs = 60_000; // 1 minute
	let timer: ReturnType<typeof setInterval> | undefined;

	function stopTimer(): void {
		if (timer !== undefined) {
			clearInterval(timer);
			timer = undefined;
		}
	}

	return {
		start() {
			runner.start();
			stopTimer();
			timer = setInterval(() => {
				runner.pulse();
			}, heartbeatMs);
			if (typeof timer.unref === "function") {
				timer.unref();
			}
		},
		stop() {
			stopTimer();
			runner.stop();
		},
	};
}
