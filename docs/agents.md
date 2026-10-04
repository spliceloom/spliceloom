# Agent packages

An agent package is a registry package that ships **instructions and a list of skills** instead of
code. Running it gives a model exactly the tools of those skills, and nothing else.

```sh
splice add @splice/robinhood --accept-permissions
splice add @splice/token-analyst
splice agent run @splice/token-analyst "Research PONS on Robinhood Chain"
```

Browse published agents at [agents.spliceloom.com](https://agents.spliceloom.com).

## What an agent can and cannot do

- It can call the tools of the skills it lists, and its own tools if it ships any.
- It has **no permissions of its own**. Each tool call runs in the sandbox of the skill that owns
  the tool, under the permissions you granted that skill when you installed it.
- It never sees a provider key. Skills reach data through host capabilities, as always.
- It cannot call Splice's built-in data tools, the web, or any skill it does not list. A call to a
  tool it was not given is refused and reported back to the model as an error.
- The skills must already be installed. `splice agent run` does not install anything: when a skill
  is missing it prints the `splice add` lines and stops before the model is called.

Instructions are text written by the publisher and are sent to the model as its system prompt.
Read them before you run an agent: `splice agent info <package>` prints the instructions, the
skills and every tool the agent can call.

## The `agent` section

`manifest.json` of an agent package:

```json
{
  "specVersion": 1,
  "namespace": "acme",
  "name": "greeter",
  "version": "0.1.0",
  "description": "Agent that greets people with the example skill.",
  "runtime": { "type": "node" },
  "permissions": { "fs": { "read": [], "write": [] }, "network": [], "env": [] },
  "tools": [],
  "agent": {
    "instructions": "Greet the person the user names. Always use the hello tool.",
    "skills": ["@splice/example"],
    "model": "openai/gpt-4o-mini",
    "examples": ["Say hi to Dim"]
  }
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `instructions` | yes | The agent's system instructions, up to 8,000 characters. |
| `skills` | yes | Package ids (`@namespace/name`) whose tools the agent may call. Up to 20; may be empty when the package ships its own tools. |
| `model` | no | Preferred model id. The host may use another; `--model` overrides it. |
| `examples` | no | Up to 6 example tasks, shown on the agent's page and by `splice agent info`. |

A package with an `agent` section may have an empty `tools` list. Every other package still needs
at least one tool. The package also needs a `SKILL.md`, like any package.

## Commands

| Command | Does |
| --- | --- |
| `splice agent run <package> "<task>" [--model id] [--provider name] [--max-tokens n] [--max-steps n] [--json]` | Runs the agent on one task and prints the answer, the tool calls, the model and the cost reported by the provider. |
| `splice agent info <package> [--json]` | Prints the instructions, the skills (and which are not installed) and the tools the agent can call. |

The model is `--model`, else the agent's `model`, else `AI_ASK_MODEL`, else the host default. It
needs an AI provider key on the host (see [AI providers](providers-ai.md)).

## Publishing an agent

Agents are published like skills: `splice publish ./my-agent`, optionally `--sign`. Publishing is
free; get a token for your own namespace at [agents.spliceloom.com](https://agents.spliceloom.com)
(see [Authentication](auth.md)). The registry lists a package as an agent when its latest version
has an `agent` section: `GET /packages/search?q=&kind=agent`.

Agent packages need CLI 0.4.0 or newer to install and run: older versions reject the `agent`
field as unknown.
