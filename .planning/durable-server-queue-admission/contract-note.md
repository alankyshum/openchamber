# v2 queue admission contract

Evidence: the running OpenCode server at `http://127.0.0.1:4096/doc` (read-only OpenAPI document).

`POST /api/session/{sessionID}/prompt` accepts `{ prompt, delivery, id }`, where
`prompt` is `{ text, files, agents }` and delivery is `steer` or `queue`.
The request is scoped with the `directory` query parameter; the client asserts
that query in its exact request test. The live OpenAPI path omits the query
parameter, so this is a conservative runtime-routing convention rather than an
OpenAPI claim.
The optional `id` is a client message id matching `^msg_`. The response is HTTP
200 JSON `{ data: SessionInputAdmitted }`; its required fields are
`admittedSeq`, `id`, `sessionID`, `prompt`, `delivery`, and `timeCreated`.
Prompt file attachments use `{ uri, name? }`, and agents use `{ name, source? }`.
The route documents 400, 401, 404, and 409 errors; this client classifies only
405 (method not allowed) as an unsupported-runtime capability result. Validation
responses, including 400 responses mentioning delivery, remain ordinary failures.
Ordinary 400/404/409 responses are deterministic failures. Lost responses and
invalid 2xx envelopes are ambiguous and are never retried. The legacy SDK `promptAsync` is intentionally not used;
raw `runtimeFetch` matches the v2 contract without an SDK bump. No session was
mutated while collecting this evidence.

The v2 prompt has no per-input provider/model/variant fields. Admission therefore
uses the server's existing session-level model/agent/variant selection and does
not claim the queued composer selection was applied. The captured selection is retained only for the
existing local fallback drain. Admitted entries retain acknowledgement sequence
metadata but drop attachment bytes and send configuration after admission.
An uncertain admission is copy/dismiss only: copying its text into the composer
is explicitly a possible duplicate and is never an automatic retry. Interrupted
pending entries are migrated to that state with attachment bytes removed.
