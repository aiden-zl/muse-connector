import { describe, expect, it } from "vitest";
import { jobKeys, softKey, keychainSafeSiteKey, SITE_KEY_RE } from "../../src/keys";
import { generatePassword, PASSWORD_RE, importCredKey, encryptSecret, decryptSecret, ctEqual } from "../../src/crypto";
import { matchAnswer, scrub, forbiddenPii, dangerFlags } from "../../src/text";

describe("jobKeys", () => {
  it("greenhouse variants collapse; different ids stay distinct", () => {
    const a = jobKeys("https://boards.greenhouse.io/acme/jobs/123?gh_src=x");
    const b = jobKeys("https://job-boards.greenhouse.io/acme/jobs/123");
    const e = jobKeys("https://boards.greenhouse.io/embed/job_app?for=acme&token=123");
    expect(a.dedupe_key).toBe("gh:acme:123");
    expect(b.dedupe_key).toBe(a.dedupe_key);
    expect(e.dedupe_key).toBe(a.dedupe_key);
    expect(a.site_key).toBe("gh:acme");
    expect(jobKeys("https://acme.com/careers?gh_jid=1").dedupe_key).not.toBe(jobKeys("https://acme.com/careers?gh_jid=2").dedupe_key);
  });
  it("lever / ashby strip apply suffixes", () => {
    expect(jobKeys("https://jobs.lever.co/Beta/UUID-1/apply").dedupe_key).toBe("lever:beta:uuid-1");
    expect(jobKeys("https://jobs.ashbyhq.com/delta/abc/application").dedupe_key).toBe("ashby:delta:abc");
  });
  it("workday ignores wdN, locale, location and apply", () => {
    const a = jobKeys("https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Software-Intern_JR1990000");
    const b = jobKeys("https://nvidia.wd1.myworkdayjobs.com/NVIDIAExternalCareerSite/job/Remote/Software-Intern_JR1990000/apply/autofillWithResume");
    expect(a.dedupe_key).toBe("wd:nvidia:jr1990000");
    expect(b.dedupe_key).toBe(a.dedupe_key);
    expect(a.site_key).toBe("wd:nvidia");
    expect(jobKeys("https://x.wd3.myworkdayjobs.com/s/job/Loc/Intern_R-12345").dedupe_key).toBe("wd:x:r-12345");
  });
  it("fallback keeps id params, drops tracking", () => {
    const a = jobKeys("https://careers.foo.com/Jobs/View?id=77&utm_source=li");
    expect(a.dedupe_key).toBe("url:careers.foo.com/Jobs/View?id=77");
  });
  it("rejects non-http", () => {
    expect(() => jobKeys("javascript:alert(1)")).toThrow();
  });
});

describe("softKey", () => {
  it("matches same internship across titles/company suffixes", () => {
    expect(softKey("Acme Inc.", "Software Engineer Intern (Summer 2027)")).toBe(softKey("Acme", "Software Engineer Internship - Summer 2027"));
    expect(softKey("Acme", "SWE Intern 2027")).not.toBe(softKey("Acme", "Quant Intern 2027"));
  });
});

describe("crypto", () => {
  it("password charset and length", () => {
    for (let i = 0; i < 200; i++) {
      const p = generatePassword();
      expect(p).toHaveLength(20);
      expect(PASSWORD_RE.test(p)).toBe(true);
      expect(/[a-z]/.test(p) && /[A-Z]/.test(p) && /[0-9]/.test(p) && /[_.!@#-]/.test(p)).toBe(true);
      expect(/^[A-Za-z]/.test(p)).toBe(true);
    }
  });
  it("AES-GCM roundtrip bound to site/row", async () => {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const key = await importCredKey(btoa(String.fromCharCode(...raw)));
    const { ciphertext, iv } = await encryptSecret(key, "s3cret", "gh:acme", 1);
    expect(await decryptSecret(key, ciphertext, iv, "gh:acme", 1)).toBe("s3cret");
    await expect(decryptSecret(key, ciphertext, iv, "gh:other", 1)).rejects.toThrow();
    await expect(decryptSecret(key, ciphertext, iv, "gh:acme", 2)).rejects.toThrow();
  });
  it("ctEqual", async () => {
    expect(await ctEqual("abc", "abc")).toBe(true);
    expect(await ctEqual("abc", "abd")).toBe(false);
    expect(await ctEqual("abc", "abcd")).toBe(false);
  });
});

describe("text", () => {
  const bank = [
    { id: 1, norm: "are you legally authorized to work in the united states", question: "", answer: "Yes", keywords: "authorized,work" },
    { id: 2, norm: "will you require sponsorship", question: "", answer: "No", keywords: "sponsorship" },
  ];
  it("matchAnswer exact and keyword", () => {
    expect(matchAnswer("Are you legally authorized to work in the United States?", bank)?.answer).toBe("Yes");
    expect(matchAnswer("Will you now or in the future require visa sponsorship?", bank)?.answer).toBe("No");
    expect(matchAnswer("What is your favorite color?", bank)).toBeNull();
    expect(matchAnswer("Are you able to work without sponsorship?", bank)).toBeNull();
    expect(matchAnswer("Are you NOT authorized to work here?", bank)).toBeNull();
  });
  it("scrub hides codes and password-like tokens", () => {
    expect(scrub("code 482913 sent")).toBe("code [digits] sent");
    expect(scrub("pw Abc123_def456.ghi7 ok")).toContain("[redacted]");
  });
  it("forbiddenPii", () => {
    expect(forbiddenPii("123-45-6789")).toBeTruthy();
    expect(forbiddenPii("card 4111 1111 1111 1111")).toBeTruthy();
    expect(forbiddenPii("date of birth 01/02/2005")).toBeTruthy();
    expect(forbiddenPii("GPA 3.9, graduating May 2029")).toBeNull();
  });
  it("dangerFlags", () => {
    expect(dangerFlags("Pay the application fee with a gift card")).toContain("money");
    expect(dangerFlags("Send me your Gmail login code")).toContain("personal_account_access");
    expect(dangerFlags("Are you authorized to work in the US?")).toEqual([]);
  });
  it("keychain-safe site keys", () => {
    expect(SITE_KEY_RE.test(keychainSafeSiteKey("url:Foo.com/it's \"bad\"\n"))).toBe(true);
  });
});
