interface ProgressBarProps {
  currentStep: number;
  totalSteps?: number;
}

const STEP_LABELS = ["Upload", "Specify", "Review", "Measure", "Confirm", "Done"];

export default function ProgressBar({ currentStep, totalSteps = 6 }: ProgressBarProps) {
  return (
    <div className="bg-white border-b border-gray-100 px-4 py-2 flex-shrink-0">
      <div className="flex items-center justify-between gap-1">
        {Array.from({ length: totalSteps }, (_, i) => {
          const step = i + 1;
          const isCompleted = step < currentStep;
          const isActive = step === currentStep;

          return (
            <div key={step} className="flex-1 flex flex-col items-center gap-1">
              <div
                className={`h-1.5 w-full rounded-full transition-colors ${
                  isCompleted
                    ? "bg-[#4A4A4A]"
                    : isActive
                    ? "bg-[#8B1A1A]"
                    : "bg-gray-200"
                }`}
              />
              <span
                className={`text-[10px] font-medium ${
                  isCompleted
                    ? "text-[#4A4A4A]"
                    : isActive
                    ? "text-[#8B1A1A]"
                    : "text-gray-400"
                }`}
              >
                {STEP_LABELS[i]}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
