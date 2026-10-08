import assert from "node:assert/strict";
import { test } from "node:test";

import { errorHandler } from "../src/middleware/error.js";

for (const source of ["", "pg/"]) {
  for (const route of ["chat", "operations/op-1/execute", "attachments", "knowledge/consent-preview", "tools/query"]) {
    test(`agent ${source}${route} parser failures never log or return secret input`, () => {
      const secret = "SYNTHETIC_SECRET_MUST_NOT_ESCAPE";
      const logs = [];
      const original = console.error;
      console.error = (...args) => logs.push(args);
      const response = {
        statusCode: null, body: null,
        set() { return this; },
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
      };
      try {
        errorHandler(Object.assign(new SyntaxError(`Unexpected token ${secret}`), {
          type: "entity.parse.failed", body: `{"reauth_password":"${secret}`,
        }), { path: `/api/v1/${source}agent/${route}`, requestId: "parser-test" }, response, () => {});
      } finally { console.error = original; }
      assert.equal(logs.length, 0);
      assert.equal(response.statusCode, 400);
      assert.equal(response.body.error.code, "VALIDATION_ERROR");
      assert.ok(!JSON.stringify(response.body).includes(secret));
    });
  }
}
