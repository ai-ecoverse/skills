# Managed CDN Config Pipeline Cross-Check

The live CDN compute API is authoritative for deployed Edge Functions,
`activePackageId`, and timestamps. If the API is temporarily unavailable, the
Managed CDN config pipeline can still identify expected function names.

Look for the Cloud Manager pipeline of type `CONFIG`. It builds `/config` from
the customer repository.

Relevant files:

- `config/compute.yaml` declares Edge Compute services.
- `config/cdn.yaml` wires CDN routing, typically with `selectAemOrigin` pointing
  at `edgefunction-<name>`.

Use this only as a fallback inventory check. A service present in the config
files may not be active until the config pipeline has deployed successfully.
