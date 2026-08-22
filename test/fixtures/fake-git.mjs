#!/usr/bin/env node
/**
 * Fake `git` for the update tests. Only understands `ls-remote`:
 *   - FAKE_GIT_TAGS  — raw ls-remote lines to print ("<sha>\trefs/tags/vX.Y.Z")
 *   - FAKE_GIT_FAIL  — exit 1 to simulate an unreachable remote
 * Anything else exits 64 so an unexpected argv can never look like success.
 */

if (process.env.FAKE_GIT_FAIL) {
	process.stderr.write("fake git: remote unreachable\n");
	process.exit(1);
}
if (process.argv.includes("ls-remote")) {
	process.stdout.write(process.env.FAKE_GIT_TAGS ?? "");
	process.exit(0);
}
process.stderr.write(`fake git: unsupported argv ${JSON.stringify(process.argv.slice(2))}\n`);
process.exit(64);
