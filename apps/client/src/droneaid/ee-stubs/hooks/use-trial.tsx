// Core expects: default useTrial() -> { isTrial, trialDaysLeft }; never a trial here.
export default function useTrial(): { isTrial: boolean; trialDaysLeft: number } {
  return { isTrial: false, trialDaysLeft: 0 };
}
