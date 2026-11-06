import fs from "fs";
import os from "os";
import path from "path";

// Every suite runs against a throwaway home so nothing touches ~/.treeboss.
process.env.TRB_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trb-test-"));
// The scripted engine: speaks claude's stream-json so the pipeline runs with no model.
process.env.TRB_FAKE_ENGINE = path.resolve(import.meta.dir, "fixtures", "fake-engine");
// Never let a test spawn a background daemon against the developer's real home.
process.env.TRB_NO_AUTOSTART = "1";
