# Organizations

> **Coming later.** Organizations are planned and **not available yet**.

## Today: namespaces, owners and maintainers

A namespace has one owner (a user) who can add maintainers; owners and maintainers can publish into
it.

```sh
splice namespace info @yourname
splice namespace add-maintainer @yourname teammate
splice namespace remove-maintainer @yourname teammate
```

Tokens can be limited to namespaces and given an expiry, which covers CI publishing for a team
([Publishing](publishing.md)).

## Planned

- Organizations as owners of namespaces, with members and roles.
- Private packages visible only to members ([Private registry](private-registry.md)).
- Organization-level API keys and provider configuration in the dashboard.
- Activity and audit logs.
