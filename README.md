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
The model can write bad rules.
The model can write rules that conflict with your instructions.
Review the rules with `/ouroboros`.
Clear the rules with `/ouroboros reset`.
The rules apply to all projects.
The rules are self-recorded lessons.
The plugin tells the model to follow them unless they conflict with your explicit instructions.
This is a prompt-level mitigation, not a guarantee.
A model can follow a bad rule despite the warning.
Review the rules regularly.
The rules file is shared by all pi instances on this machine.
Two pi instances can write rules at the same time.
The plugin serializes writes within one instance.
The plugin verifies its writes and retries on conflict.
The plugin does not lock the file across instances.
Run one pi instance at a time to avoid lost rules.

The digest content is untrusted data.
The digest can contain text from files, tools, or other agents.
The reflection message tells the model to ignore instructions inside the digest.
The plugin escapes XML-like tags in every digest text field.
The model records lessons with the `ouroboros_learn` tool.
The tool appends, dedupes, and caps the rules.
The tool strips control characters from rules.
The tool refuses to overwrite an existing skill.
The tool caps the skill body and description.
The reflection message tells the model to use the tool, not the write tool.
If the model uses its write tool anyway, it overwrites the file and bypasses the dedup and cap.

## Performance

The plugin adds less than 3 ms to a session start.
pi.dev awaits every event handler.
The plugin keeps handler work small.

Measured costs:

- Session start with no digests: 0.002 ms.
- Session start with 1 digest: 0.037 ms.
- Session start with 50 digests: 0.096 ms.
- Rules read per turn (cached): 0.001 ms.
- Skills read per turn (cached): 0.002 ms.
- Rule append at cap (char eviction): 0.058 ms.
- Digest list with 10,000 digests: 21 ms.
- Digest build with a 300 KB prompt: 0.062 ms.
- Digest build with 10,000 tool calls (capped): 3.9 ms.
- Digest save (atomic write): 0.021 ms.

The plugin caches the rules file.
The plugin invalidates the cache on its own writes.
The plugin checks the file mtime for external writes.
The plugin caches the skills list.
The plugin invalidates the skills cache on its own writes.
The plugin examines every pending digest at session start.
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
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Directory for all ouroboros state (rules, digests, skills) |

All ouroboros state lives under the agent directory.
Changing `PI_CODING_AGENT_DIR` starts fresh: the old rules, digests, and skills stay in the old directory.

## Development

Run these commands:

```bash
bun install
bun test
npx tsc --noEmit
```


The tests cover digest extraction, persistence, prompt building, and the extension entry point.
Run `bun bench/bench.ts` to measure the hot paths.

The test suite has 138 tests.

The reflection happens at the start of the next session.
The reflection does not happen at shutdown.
Shutdown must stay fast.
The agent loop is the best place to reflect.
The agent already has the tools to write files.

Digests are lossy on purpose.
The plugin drops thinking traces and full outputs.
The reflection prompt stays small and cheap.

Rules are injected every turn.
Skills are loaded on demand.
A rule must be in context when the mistake can happen.

## License

MIT
