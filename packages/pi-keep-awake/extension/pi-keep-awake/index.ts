import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createKeepAwakeController } from "./helper/keep-awake.js";

export default function (pi: ExtensionAPI): void {
	const keepAwake = createKeepAwakeController();

	pi.on("agent_start", async () => {
		keepAwake.start();
	});

	pi.on("agent_end", async () => {
		keepAwake.stop();
	});

	pi.on("session_shutdown", async () => {
		keepAwake.stop();
	});
}
