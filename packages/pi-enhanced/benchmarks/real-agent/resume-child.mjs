// Loaded before Pi. A parent that dies before recording this PID cannot release the child.
if (!process.connected) throw new Error("EVAL_V3_RESUME_PARENT_ABSENT");
await new Promise((resolve, reject) => {
	const disconnected = () => reject(new Error("EVAL_V3_RESUME_PARENT_ABSENT"));
	process.once("disconnect", disconnected);
	process.once("message", message => {
		process.off("disconnect", disconnected);
		if (message === "resume-claimed") resolve();
		else reject(new Error("EVAL_V3_RESUME_CLAIM_INVALID"));
	});
});
process.disconnect();
