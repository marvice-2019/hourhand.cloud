// Sample provider answers, shaped after the documented responses (Calendly OpenAPI EventType / EventTypeCustomQuestion;
// Cal.com v2 GET /v2/event-types, cal-api-version 2026-06-12). Used by the tests only.

export const CALENDLY_ME = { resource: { uri: "https://api.calendly.com/users/AAAA", name: "Priya", slug: "priya" } };

const calendlyType = (over: Record<string, unknown>) => ({
  uri: "https://api.calendly.com/event_types/X", name: "Intro call", slug: "intro-call", active: true, secret: false, kind: "solo",
  pooling_type: null, duration: 30, duration_options: null, description_plain: "A quick hello.", start_time_increment: 30,
  before_buffer: 0, after_buffer: 0, locations: [{ kind: "google_conference" }], custom_questions: [], profile: { type: "User" },
  ...over,
});

export const CALENDLY_PAGE_1 = {
  collection: [
    calendlyType({
      uri: "https://api.calendly.com/event_types/A", name: "Coaching", slug: "coaching", duration: 45, duration_options: [30, 45, 60],
      secret: true, before_buffer: 10, after_buffer: 15, start_time_increment: 25, description_plain: "Deep-dive coaching session.",
      locations: [{ kind: "physical", location: "12 MG Road, Bengaluru" }, { kind: "zoom_conference" }],
      custom_questions: [
        { name: "What should we cover?", type: "text", position: 1, enabled: true, required: true, answer_choices: [], include_other: false },
        { name: "Company", type: "string", position: 0, enabled: true, required: false, answer_choices: [], include_other: false },
        { name: "WhatsApp number", type: "phone_number", position: 2, enabled: true, required: false, answer_choices: [], include_other: false },
        { name: "How did you hear of us?", type: "single_select", position: 3, enabled: true, required: false, answer_choices: ["Friend", "Instagram"], include_other: true },
        { name: "Old question", type: "string", position: 4, enabled: false, required: false, answer_choices: [], include_other: false },
        { name: "Pick one", type: "single_select", position: 5, enabled: true, required: false, answer_choices: ["Only"], include_other: false },
      ],
    }),
    calendlyType({ uri: "https://api.calendly.com/event_types/B", name: "Team demo", slug: "team-demo", pooling_type: "round_robin" }),
  ],
  pagination: { count: 2, next_page: "https://api.calendly.com/event_types?page_token=PAGE2", next_page_token: "PAGE2" },
};

export const CALENDLY_PAGE_2 = {
  collection: [
    calendlyType({ uri: "https://api.calendly.com/event_types/C", name: "Workshop", slug: "workshop", kind: "group", duration: 1440, active: false }),
    calendlyType({ uri: "https://api.calendly.com/event_types/D", name: "Quick", slug: "quick", duration: 2, locations: [] }),
  ],
  pagination: { count: 2, next_page: null, next_page_token: null },
};

export const CALCOM_LIST = {
  status: "success",
  data: [
    {
      id: 101, title: "Strategy session", slug: "strategy", lengthInMinutes: 60, lengthInMinutesOptions: [30, 60], description: "Plan the quarter.",
      beforeEventBuffer: 5, afterEventBuffer: 300, minimumBookingNotice: 120, hidden: false, seats: { seatsPerTimeSlot: 1, disabled: true },
      locations: [{ type: "integration", integration: "google-meet" }],
      bookingFields: [
        { type: "name", slug: "name", isDefault: true, required: true },
        { type: "email", slug: "email", isDefault: true, required: true },
        { type: "longText", slug: "agenda", label: "Agenda", required: true, isDefault: false },
        { type: "select", slug: "budget", label: "Budget", required: false, options: ["Under 1L", "1L to 5L"] },
        { type: "checkboxGroup", slug: "topics", label: "Topics", required: false, options: ["SEO", "Ads", "Brand"] },
        { type: "number", slug: "team", label: "Team size", required: false },
        { type: "url", slug: "site", label: "Website", required: false, hidden: true },
        { type: "phone", slug: "attendeePhoneNumber", label: "Phone", required: false },
      ],
    },
    {
      id: 102, title: "Yoga class", slug: "yoga", lengthInMinutes: 60, description: null, beforeEventBuffer: 0, afterEventBuffer: 0,
      minimumBookingNotice: 0, hidden: true, seats: { seatsPerTimeSlot: 20, showAttendeeInfo: false, showAvailabilityCount: true, disabled: false },
      locations: [{ type: "address", address: "Indiranagar studio", public: true }], bookingFields: [],
    },
    { id: 103, title: "Sales round robin", slug: "sales", lengthInMinutes: 30, schedulingType: "roundRobin", teamId: 9, bookingFields: [] },
  ],
};
