# Architecture

No application stack is locked by the harness installer. Record stack choices in
`docs/decisions/` when they constrain future work.

## Default Layering

```text
domain
  <- application
      <- infrastructure
          <- interface
              <- app surfaces
```

Inner layers must not depend on outer layers. Parse unknown input at boundaries
before it enters domain code.
