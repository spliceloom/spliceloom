# @splice/example

The official example skill for Splice. It exists to show the package format end to end and
has no external dependencies or API calls.

## Tools

### `example.hello`

Returns a greeting.

| Input     | Type    | Required | Notes                         |
| --------- | ------- | -------- | ----------------------------- |
| `name`    | string  | yes      | 1–100 characters              |
| `excited` | boolean | no       | ends the message with `!`     |

Output: `{ "message": string }`

```sh
splice run example.hello name=Dim
splice run example.hello --input '{"name":"Dim","excited":true}'
```

### `example.stats`

Counts characters, words and lines in text.

Input: `{ "text": string }` (max 100 000 characters)

Output: `{ "characters": integer, "words": integer, "lines": integer, "longestWord": string }`

```sh
splice run example.stats text="Splice composes capabilities"
```

## Permissions

None. Both tools run in the Splice sandbox with no file system access outside the package,
no network access and no environment variables. See `examples/` for sample inputs.

## When should an agent use this skill?

- To verify a Splice installation works.
- As a template when writing a new skill.
