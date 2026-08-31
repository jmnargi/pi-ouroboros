# pi-ouroboros

pi-ouroboros is a plugin for the pi coding agent.
The plugin makes pi improve itself.
Pi analyzes its own sessions.
Pi extracts lessons from its own mistakes.
Pi writes its own rules and skills.
The next session starts with more knowledge.

## How the plugin works

The plugin has four parts.

1. Session end.
   The plugin writes a digest of the session.
   The digest contains prompts, tool calls, assistant text, failures, stop reasons, and usage.
   The plugin stores the digest in `~/.pi/agent/ouroboros/digests/`.

2. Next session start.
   The plugin checks for a pending digest.
   The plugin queues a reflection message for the first turn.
   The reflection message contains the digest.

3. Agent reflection.
   The agent reads the digest.
   The agent identifies 1 to 3 lessons.
   The agent writes rules to `~/.pi/agent/ouroboros/rules.md`.
   The agent writes skills to `~/.pi/agent/skills/<name>/SKILL.md`.

4. Every turn.
   The plugin appends the rules to the system prompt.
   A new rule is active on the next turn.

## Install

Run this command:

```bash
pi install ./pi-ouroboros
```

## Trust model

The model writes the rules and the skills.
The model can write incorrect rules.
The model can write rules that conflict with your instructions.
Review the rules with `/ouroboros`.
Clear the rules with `/ouroboros reset`.
The rules apply to all projects.
The rules are self-recorded lessons.
The plugin tells the model to follow them unless they conflict with your explicit instructions.
This is a prompt-level mitigation, not a guarantee.
A model can follow an incorrect rule despite the warning.
Review the rules regularly.
All pi instances on this machine share the rules file.
Two pi instances can write rules at the same time.
The plugin serializes writes within one instance.
The plugin verifies its writes and retries on conflict.
The plugin does not lock the file across instances.
Run one pi instance at a time to avoid lost rules.
Two concurrent instances can also deliver the same reflection twice.
The marker protocol has no ownership across processes.
A crash between the reflection delivery and the marker cleanup can also deliver it twice.
The lessons are deduplicated, so the second delivery is harmless.
After a reload, the plugin reconciles the markers.
The queued message survives the reload.
The plugin delivers it once.

The digest content is untrusted data.
The digest can contain text from files, tools, or other agents.
The reflection message tells the model to ignore instructions inside the digest.
The plugin escapes XML-like tags in every digest text field.
The model records lessons with the `ouroboros_learn` tool.
The tool appends, dedupes, and caps the rules.
The tool strips control characters from rules.
The tool refuses to overwrite an existing skill.
The tool caps the skill body and description.
The plugin refuses to read or write rules through a symlinked ouroboros dir.
The plugin refuses to read or write digests through a symlinked ouroboros dir.
The plugin refuses to read or write skills through a symlinked skills dir.
The plugin treats a symlinked dir as untrusted.
The plugin never follows a symlinked ouroboros, digests, or skills dir.
The plugin does follow a symlinked rules.md file.
The rules.md file symlink is a deliberate feature for dotfiles setups.
The reflection message tells the model to use the tool, not the write tool.
If the model uses its write tool anyway, it overwrites the file and bypasses the dedup and cap.

## Performance

The plugin adds less than 3 ms to a session start.
pi.dev awaits every event handler.
The plugin keeps handler work small.

Measured costs:
- Session start with no digests: 0.007 ms.
- Session start with 1 digest: 0.063 ms.
- Session start with 50 digests: 0.129 ms.
- Rules read per turn (cached): 0.001 ms.
- Skills read (uncached): 0.006 ms.
- Rule append at cap (char eviction): 0.054 ms.
- Digest list with 10,000 digests: 23 ms.
- Digest build with a 300 KB prompt: 0.026 ms.
- Digest build with 10,000 tool calls (capped): 6.3 ms.
- Digest save (atomic write): 0.030 ms.

The plugin caches the rules file.
The plugin does not cache the skills list.
The skills list is a few syscalls at session start and on tool use.
The plugin scans every pending digest at session start.
The plugin injects one reflection per session start.
The plugin keeps the remaining pending digests for the next session start.
The plugin deletes non-notable and corrupt digests during the scan.
The plugin skips the per-turn cleanup when nothing is pending.
Run `bun bench/bench.ts` to re-measure the hot paths.

## Usage

The plugin works automatically.
You do not need to do anything.

Use these commands:

- `/ouroboros` shows the status.
- `/ouroboros reflect` forces a reflection now.
- `/ouroboros reset` clears all rules.
- `/ouroboros digest` shows the last session's digest.

Use the `ouroboros_learn` tool to record a lesson.
Use `kind=rule` to add a rule.
Use `kind=skill` to write a skill.

## Configuration

Use environment variables to change the behavior.

| Variable | Default | Meaning |
|---|---|---|
| `PI_OUROBOROS_DISABLED` | none | Set to `1` to disable the plugin |
| `PI_OUROBOROS_RULES_CAP` | `50` | Maximum number of rules |
| `PI_OUROBOROS_RULES_MAX_CHARS` | `3000` | Maximum characters of rules per turn. The plugin also evicts the oldest rules when the file exceeds this budget. The plugin truncates a single rule at 500 characters. |
| `PI_OUROBOROS_REFLECT_MIN_PROMPTS` | `5` | Minimum prompts for a clean session to be notable (floor 20) |
The plugin stores all ouroboros state in the agent directory.

Changing `PI_CODING_AGENT_DIR` creates a new state directory.
The old rules, digests, and skills stay in the old directory.

## Development

Run these commands:

```bash
bun install
bun test
npx tsc --noEmit
```

The tests cover digest extraction, persistence, prompt building, and the extension entry point.
The test suite has 235 tests.
The reflection happens at the start of the next session.
The reflection does not happen at shutdown.
Shutdown must stay fast.
The agent loop is the correct place to reflect.
The agent already has the tools to write files.

Digests are lossy by design.
The plugin drops thinking traces and full outputs.
The reflection prompt stays small and low-cost.

The plugin injects the rules every turn.
Pi loads the skill content on demand.
A rule must be in context when the mistake can happen.

## License

MIT
