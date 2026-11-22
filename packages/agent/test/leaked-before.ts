/**
 * Texts that an earlier version of this code, which cleaned what a page said by rules, let through in part or in
 * whole, as independent reviews found them. None of it is kept now in any form, so none of what is in
 * SECRETS_BEFORE may appear anywhere in what a run collects or in its result.
 */
export const LEAKED_BEFORE = [
  "Could not load points for ada@example.test, token=tok_live_4f9a8b7c6d5e and Authorization: Bearer abcdefghijklmnop",
  "password=Tr0ub&dor;3x-23",
  '{"user":"ada","password":"json-tight-3","x":1}',
  '{ "user": "ada", "password": "json-spaced-1", "nested": { "token": "json-nested-2" } }',
  "{password: correct horse battery-26}",
  "login failed {access_token: first-key-123, user: ada}",
  "error loading login?next=home&password=rel-query-36 now",
  "password=x://y/addr-value-38 more-words-38",
  "tried Zq7%21vault-pw twice and Zq7%2521vault-pw again",
  "X-Authorization: x-authz-39",
  "config['password'] = 'bracketed-45'",
  "user[password]=form-46&commit=1",
  "Error:password=second-49",
  "aws_secret_access_key_2 = long-name-53",
  "password for admin: after-words-62",
  "Invalid password supplied: after-words-63",
  "password\uFF1A wide-colon-68",
  "password\rcarriage-74",
  "password\u2028line-sep-75",
  "token-glued-76 pin#4821-77 Bearerstuck-78",
  "POST /api/password after-path-79",
  "GET https://a.example/api/token after-address-80",
  "/cb?sid= after-query-81",
  "password@host after-mail-82",
  "see ://Zq7%21vault-pw",
  "GET https://a.example/reset/token/in-link-83 failed",
  "GET https://a.example/verify/otp/493817 failed",
  "foo%00bar%1Bbaz g%E2%80%AEh",
  "/x\ud800=1?a",
  "card 4111111111111111 for ada@example.test",
  "{{secret:eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmb3JnZWQtNDMifQ.Sflx}}",
];
export const LEAKED_PATHS = ["/reset/token/in-link-83", "/verify/otp/493817", "/pin/4821", "/session/ab12cd3", "/password/in-path-84", "/token-in-path-85", "/users/ada@example.test/password=in-path-1", "/reset/tok4f9a8b7c6d5e4f3a2b1c", "/find/Zq7%21vault-pw"];
export const SECRETS_BEFORE = [
  "ada@example.test", "tok_live_4f9a8b7c6d5e", "abcdefghijklmnop", "dor;3x-23", "json-tight-3", "json-spaced-1", "json-nested-2", "battery-26", "first-key-123", "rel-query-36", "next=home", "addr-value-38",
  "more-words-38", "vault-pw", "x-authz-39", "bracketed-45", "form-46", "second-49", "long-name-53", "after-words-62", "after-words-63", "wide-colon-68", "carriage-74", "line-sep-75", "glued-76", "4821", "stuck-78",
  "after-path-79", "after-address-80", "after-query-81", "after-mail-82", "in-link-83", "493817", "a.example", "4111111111111111", "eyJhbGciOiJIUzI1NiJ9", "ab12cd3", "in-path-84", "in-path-85", "in-path-1", "tok4f9a8b7c6d5e4f3a2b1c",
  // And nothing of what the lines say at all.
  "Could not load", "points for", "login failed", "tried", "supplied", "twice",
];
