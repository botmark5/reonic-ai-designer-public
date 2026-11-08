import { describe, expect, it } from "vitest";
import { stripVoiceTags } from "./display-text";

describe("stripVoiceTags (display only)", () => {
  it("removes ElevenLabs-style bracket tags and collapses spaces", () => {
    expect(stripVoiceTags("[excited] Great, a heat pump! [laughs]  So, how many people live there?")).toBe(
      "Great, a heat pump! So, how many people live there?",
    );
    expect(stripVoiceTags("Okay [pause] got it.")).toBe("Okay got it.");
  });
  it("keeps the rest of the text, line breaks and non-tag brackets", () => {
    expect(stripVoiceTags("Line one\nLine two")).toBe("Line one\nLine two");
    expect(stripVoiceTags("A [ ] gap")).toBe("A gap");
    expect(stripVoiceTags("[" + "x".repeat(41) + "] stays")).toBe("[" + "x".repeat(41) + "] stays");
  });
  it("tolerates empty input", () => {
    expect(stripVoiceTags("")).toBe("");
    expect(stripVoiceTags(null)).toBe("");
    expect(stripVoiceTags(undefined)).toBe("");
  });
});

describe("stripVoiceTags punctuation", () => {
  it("does not leave a space before punctuation", () => {
    expect(stripVoiceTags("Got it [laughs].")).toBe("Got it.");
  });
});
