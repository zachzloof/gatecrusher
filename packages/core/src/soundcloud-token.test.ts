import { describe, expect, it } from "vitest";
import { soundcloudTokenSchema } from "./soundcloud-token.ts";

// Made-up values in the shape SoundCloud uses; never a real token.
const TOKEN = "2-290123-123456789-aBcDeFgHiJkLmN";

describe("soundcloudTokenSchema", () => {
  it.each([
    ["the bare value", TOKEN],
    ["padded with whitespace", `  ${TOKEN}\n`],
    ["wrapped in quotes", `"${TOKEN}"`],
    ["copied as name=value", `oauth_token=${TOKEN}`],
    ["copied as name=value;", `oauth_token=${TOKEN};`],
    ["copied as an Authorization header value", `OAuth ${TOKEN}`],
  ])("accepts %s and keeps only the value", (_label, input) => {
    const parsed = soundcloudTokenSchema.safeParse(input);

    expect(parsed.success && parsed.data).toBe(TOKEN);
  });

  it.each([
    ["empty", ""],
    ["too short", "2-abc"],
    ["with a space inside", "2-290123-123456789 aBcDeFgHiJkLmN"],
    ["with a tab", `${TOKEN}\tsoundcloud.com`],
    ["with a newline inside", `${TOKEN}\n.evil.example\tTRUE`],
    ["a whole cookie header", `sc_anonymous_id=abc; oauth_token=${TOKEN}`],
    ["way too long", "a".repeat(5000)],
  ])("rejects %s", (_label, input) => {
    const parsed = soundcloudTokenSchema.safeParse(input);

    expect(parsed.success).toBe(false);
  });

  it("never repeats the value in its error message", () => {
    const parsed = soundcloudTokenSchema.safeParse("2-290123 not-a-token-but-secret");

    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).not.toContain("not-a-token-but-secret");
  });
});
