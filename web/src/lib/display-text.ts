/**
 * Voice-agent text for display: ElevenLabs-style bracket tags ([excited], [laughs], [pause] …) are stage directions
 * for the voice, not words. Strip them from what the UI shows; the stored transcript and summary stay untouched.
 */
const TAG = /\[[^\]\n]{1,40}\]/g;

export function stripVoiceTags(text: string | null | undefined): string {
  if (!text) return "";
  return text
    .replace(TAG, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([,.!?;:])/g, "$1")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .trim();
}
