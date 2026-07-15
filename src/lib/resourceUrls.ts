export function getResourceUrlContext(): Record<string, string> {
  return {
    ai_interview_report_url:
      process.env.GMAIL_AI_REPORT_URL?.trim() ?? "",
    expert_interview_report_url:
      process.env.GMAIL_EXPERT_REPORT_URL?.trim() ?? "",
    candidate_comparison_report_url:
      process.env.GMAIL_COMPARISON_REPORT_URL?.trim() ?? "",
  };
}
