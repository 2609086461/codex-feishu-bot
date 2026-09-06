import assert from "node:assert/strict";
import test from "node:test";

import { GitProjectService } from "./git-project-service.js";

const service = new GitProjectService({
  info() {
    return undefined;
  },
  warn() {
    return undefined;
  }
});

test("GitProjectService accepts credential-free HTTPS and SSH remotes", () => {
  assert.equal(
    service.validateRemoteUrl("https://github.com/cai/resume.git"),
    "https://github.com/cai/resume.git"
  );
  assert.equal(
    service.validateRemoteUrl("git@github.com:cai/resume.git"),
    "git@github.com:cai/resume.git"
  );
  assert.equal(
    service.validateRemoteUrl("ssh://git@github.com/cai/resume.git"),
    "ssh://git@github.com/cai/resume.git"
  );
});

test("GitProjectService rejects credentials embedded in remotes", () => {
  assert.throws(
    () => service.validateRemoteUrl("https://user:secret@github.com/cai/resume.git"),
    /不能包含账号、令牌或密码/
  );
});

test("GitProjectService validates branch names", () => {
  assert.equal(service.validateBranch("main"), "main");
  assert.equal(service.validateBranch("bot/resume-update"), "bot/resume-update");
  assert.throws(() => service.validateBranch("../main"), /格式不正确/);
  assert.throws(() => service.validateBranch("-main"), /格式不正确/);
});
