import { describe, expect, it } from "vitest";
// @ts-ignore
import { classify } from "../../sourcer/eligibility.mjs";

describe("eligibility", () => {
  const c = (text: string, title = "Software Engineer Intern") => classify(title, text).eligibility;
  it("explicit 2029", () => expect(c("Candidates must be graduating in 2029.")).toBe("explicit_2029"));
  it("range includes", () => expect(c("Pursuing a BS, graduating between December 2027 and June 2030.")).toBe("range_includes_2029"));
  it("or later", () => expect(c("Expected graduation date of 2028 or later.")).toBe("range_includes_2029"));
  it("excludes", () => expect(c("Must be graduating in December 2027 or May/June 2028.")).toBe("excludes_2029"));
  it("sophomore program", () => expect(c("This program is for current freshmen and sophomores.")).toBe("explicit_2029"));
  it("rising seniors only", () => expect(c("Open to rising seniors.")).toBe("excludes_2029"));
  it("program season year not mistaken for grad year", () =>
    expect(c("Join our Summer 2027 internship. Graduation requirements: currently enrolled in a degree program.")).toBe("unstated"));
  it("unstated", () => expect(c("Pursuing a degree in Computer Science.")).toBe("unstated"));
});
