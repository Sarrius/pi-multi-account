import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { googleHelpersURL } from "../google-transport/host-helpers.ts";

test("#117: a host without pi-ai or its public Google helper fails without using unrelated packages", () => {
 const root=mkdtempSync(join(tmpdir(), "pi-host-missing-"));
 try {
  writeFileSync(join(root,"package.json"),JSON.stringify({name:"@earendil-works/pi-coding-agent"}));
  const missing=/Cannot locate the host's .* Google helpers/;
  assert.throws(()=>googleHelpersURL(root),missing);
  const sdk=join(root,"node_modules/@earendil-works/pi-ai");mkdirSync(sdk,{recursive:true});
  writeFileSync(join(sdk,"package.json"),JSON.stringify({name:"@earendil-works/pi-ai",exports:{".":"./public.js"}}));
  writeFileSync(join(sdk,"public.js"),"export {};\n");
  assert.throws(()=>googleHelpersURL(root),missing);
 } finally {rmSync(root,{recursive:true,force:true});}
});
