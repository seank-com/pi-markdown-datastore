/** Batch published notes without extending the delay on every new message. */
export function semanticRefreshBatch(
	request: (signal: AbortSignal) => Promise<boolean>,
	report: (error?: unknown) => void,
	delayMs = 5 * 60_000,
) {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let pending = false;
	let active: Promise<void> | undefined;
	const schedule = () => {
		if (controller.signal.aborted) return;
		pending = true;
		if (timer || active) return;
		timer = setTimeout(() => {
			timer = undefined;
			pending = false;
			active = Promise.resolve().then(() => request(controller.signal)).then((started) => {
				// A coalesced job may have taken its snapshot before these notes existed.
				if (!started) pending = true;
				if (!controller.signal.aborted) report();
			}, (error) => {
				pending = true;
				if (!controller.signal.aborted) report(error);
			}).finally(() => {
				active = undefined;
				if (pending) schedule();
			});
		}, delayMs);
		timer.unref?.();
	};
	return {
		schedule,
		async close() {
			controller.abort();
			if (timer) clearTimeout(timer);
			timer = undefined;
			await active;
		},
	};
}
