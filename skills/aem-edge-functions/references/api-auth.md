# API and Authentication Details

The CDN compute API requires an IMS access token minted from an Adobe Developer
Console OAuth Server-to-Server credential whose scopes include `aem.cdn`.
Generic IMS shell tokens authenticate but usually fail with
`401 {"error":"Insufficient scopes"}`.

Token minting uses:

```text
POST https://ims-na1.adobelogin.com/ims/token/v3
grant_type=client_credentials
client_id=<ADC client id>
client_secret=<ADC client secret>
scope=openid,AdobeID,aem.cdn,additional_info.projectedProductContext
```

List request:

```text
GET {base}/edgeFunctions
Authorization: Bearer <token>
accept: application/json
```

List response:

```json
{
  "items": [
    {
      "edgeFunctionName": "wknd-compute",
      "createdAt": "2026-06-01T10:00:00Z",
      "updatedAt": "2026-06-02T10:00:00Z",
      "activePackageId": "123"
    }
  ]
}
```

Purge request:

```text
POST {base}/edgeFunctions/{service}/purge
Authorization: Bearer <token>
content-type: application/json
```

Exactly one purge mode is required:

```json
{ "all": true }
```

```json
{ "surrogateKey": "key1" }
```

```json
{ "surrogateKeys": ["key1", "key2"], "soft": true }
```

A bodyless purge POST returns `400 Invalid JSON body`.
