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

// @ts-ignore
import { usOk } from "../../sourcer/eligibility.mjs";
describe("usOk", () => {
  it("filters non-US", () => {
    expect(usOk("London, UK")).toBe(false);
    expect(usOk("China, Shanghai")).toBe(false);
    expect(usOk("Toronto, ON, Canada")).toBe(false);
    expect(usOk("Remote - Canada")).toBe(false);
  });
  it("keeps US / unknown", () => {
    expect(usOk("New York, NY")).toBe(true);
    expect(usOk("San Francisco, CA, US; London, UK")).toBe(true);
    expect(usOk("Remote")).toBe(true);
    expect(usOk("7 Locations")).toBe(true);
    expect(usOk("")).toBe(true);
    expect(usOk("Austin, TX")).toBe(true);
  });
  it("stated years beat class-standing keywords", () => {
    expect(classify("SWE Intern", "Open to sophomores graduating in 2027.").eligibility).toBe("excludes_2029");
  });
});
