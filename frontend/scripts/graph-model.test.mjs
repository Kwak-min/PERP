import assert from "node:assert/strict";
import { test } from "node:test";
import { noteSchema, noteDetailSchema } from "../src/screens/vault/model.ts";

test("missing or malformed concurrency version cannot become version one", () => {
  for (const version of [undefined, "", "not-a-version", -1, 1.5]) {
    assert.equal(noteSchema.safeParse({id:"1",title:"Note",version}).success,false);
  }
  assert.equal(noteSchema.parse({id:"1",title:"Note",version:42}).version,42);
  assert.equal(noteSchema.parse({id:"1",title:"Note",version:"987654"}).version,"987654");
});

test("a partial detail cannot silently become an empty note draft", () => {
  assert.equal(noteDetailSchema.safeParse({id:"1",title:"Note",version:42}).success,false);
  assert.equal(noteDetailSchema.parse({id:"1",title:"Note",version:42,content:""}).content,"");
});
