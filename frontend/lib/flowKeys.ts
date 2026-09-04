export function clearFlowSession() {
  if (typeof window !== "undefined") {
    const keys = [
      "upload_result",
      "specified_rooms",
      "review_result",
      "review_completed",
      "measurements_draft",
      // The guided-checklist values. Was absent here, so a finished apartment's measurements
      // survived into the next upload and could rehydrate into a different apartment's rooms.
      "plan_values_draft",
      "measure_result",
      "confirm_data",
      "came_from_measure",
      "upload_for_apartment"
    ];
    keys.forEach((k) => sessionStorage.removeItem(k));
  }
}
