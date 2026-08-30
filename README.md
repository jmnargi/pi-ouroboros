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
   The digest contains prompts, failures, stop reasons, and usage.
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
The rules do not override your explicit instructions.
The rules file is shared by all pi instances on this machine.
Two pi instances can write rules at the same time.
The plugin serializes writes within one instance.
The plugin does not lock the file across instances.
Run one pi instance at a time to avoid lost rules.

## Usage

The plugin works automatically.
You do not need to do anything.

Use these commands:

- `/ouroboros` shows the status.
- `/ouroboros reflect` forces a reflection now.
- `/ouroboros reset` clears all rules.
- `/ouroboros digest` shows the latest digest.

Use the `ouroboros_learn` tool to record a lesson.
Use `kind=rule` to add a rule.
Use `kind=skill` to write a skill.

## Configuration

Use environment variables to change the behavior.

| Variable | Default | Meaning |
|---|---|---|
| `PI_OUROBOROS_DISABLED` | none | Set to `1` to disable the plugin |
| `PI_OUROBOROS_RULES_CAP` | `50` | Maximum number of rules |
| `PI_OUROBOROS_RULES_MAX_CHARS` | `3000` | Maximum characters of rules per turn |
| `PI_OUROBOROS_REFLECT_MIN_PROMPTS` | `5` | Minimum prompts for a notable session |

## Development

Run these commands:

```bash
bun install
bun test
npx tsc --noEmit
```

The test suite has 43 tests.
The tests cover digest extraction, persistence, and prompt building.

## Design notes

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
