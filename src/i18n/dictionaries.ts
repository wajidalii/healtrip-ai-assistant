/**
 * UI copy for both locales. `Dictionary` is derived from the English object so
 * TypeScript guarantees the Arabic dictionary has exactly the same keys.
 */
import type {
  Language,
  Locale,
  NextStep,
  PriceTier,
  ProviderKind,
  Specialty,
  Urgency,
} from "@/shared/contracts";

/** Tool names the agent loop can emit (see docs/AGENT.md). */
export const TOOL_NAMES = [
  "assess_urgency",
  "search_providers",
  "get_provider_details",
  "recommend_next_step",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export function isToolName(name: string): name is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(name);
}

const en = {
  title: "HealTrip",
  subtitle: "AI Patient Decision Assistant",
  tagline:
    "Describe what you are experiencing and the assistant will help you decide what to do next: see a specialist, go to the ER, or get a second opinion.",
  placeholder: "Describe your symptoms, how long you have had them, and where you are…",
  send: "Send",
  cancel: "Stop",
  newConversation: "New conversation",
  you: "You",
  assistant: "Assistant",
  thinking: "Thinking…",
  retry: "Retry",
  startNewHint: "This conversation cannot continue. Please start a new conversation.",
  /** Western digits everywhere (counter, ratings, tool summaries and copy), the usual choice in medical UIs. */
  charCount: (used: number, max: number) => `${used} / ${max}`,
  /** Joins short enumerations (specialties, languages, "city, country"). */
  listSeparator: ", ",
  toolActivity: "What the assistant checked",
  samplePromptsTitle: "Try an example",
  samplePrompts: [
    "I have chest pain and I’m not sure whether I should see a cardiologist, go to the ER, or seek a second opinion.",
    "My 6-year-old has had a fever of 39°C for two days and a rash on her chest. We are in Dubai.",
    "I was diagnosed with a herniated disc in Cairo and want a second opinion from an orthopedic specialist who speaks English.",
  ],
  toolLabels: {
    assess_urgency: "Checking urgency",
    search_providers: "Searching providers",
    get_provider_details: "Loading provider details",
    recommend_next_step: "Preparing recommendation",
  } satisfies Record<ToolName, string>,
  toolStatus: { running: "In progress", ok: "Done", error: "Failed" },
  nextStepLabels: {
    emergency_now: "Go to the emergency room now",
    urgent_care_24h: "Seek urgent care within 24 hours",
    specialist_consultation: "Book a specialist consultation",
    second_opinion: "Get a second opinion",
    primary_care: "See a primary care doctor",
    self_care_monitor: "Self-care and monitor",
  } satisfies Record<NextStep, string>,
  urgencyLabels: {
    emergency: "Emergency",
    urgent: "Urgent",
    routine: "Routine",
    self_care: "Self-care",
  } satisfies Record<Urgency, string>,
  recommendation: {
    title: "Recommended next step",
    urgency: "Urgency",
    rationale: "Why",
    questionsRemaining: "To refine this, it would help to know",
    providers: "Matching providers from our database",
    noProviders: "No providers were attached to this recommendation.",
    disclaimer:
      "This is decision support, not a medical diagnosis. It cannot replace an examination by a licensed clinician.",
  },
  emergencyBanner: {
    title: "This may be an emergency",
    body: "Call your local emergency services now or go to the nearest emergency department. Do not wait for this assistant.",
  },
  provider: {
    emergencyCapable: "Emergency care",
    telemedicine: "Telemedicine",
    acceptsInternational: "International patients",
    rating: "Rating",
    languages: "Languages",
    specialties: "Specialties",
  },
  providerKind: {
    hospital: "Hospital",
    clinic: "Clinic",
    doctor: "Doctor",
  } satisfies Record<ProviderKind, string>,
  priceTier: {
    low: "Budget",
    mid: "Mid-range",
    high: "Premium",
  } satisfies Record<PriceTier, string>,
  languages: {
    en: "English",
    ar: "Arabic",
    tr: "Turkish",
    de: "German",
    fr: "French",
  } satisfies Record<Language, string>,
  specialties: {
    cardiology: "Cardiology",
    neurology: "Neurology",
    orthopedics: "Orthopedics",
    oncology: "Oncology",
    dermatology: "Dermatology",
    gastroenterology: "Gastroenterology",
    general_practice: "General practice",
    emergency_medicine: "Emergency medicine",
    pediatrics: "Pediatrics",
    psychiatry: "Psychiatry",
    ophthalmology: "Ophthalmology",
    dentistry: "Dentistry",
    pulmonology: "Pulmonology",
    endocrinology: "Endocrinology",
  } satisfies Record<Specialty, string>,
  errors: {
    generic: "Something went wrong. Please try again.",
    timeout: "The assistant stopped responding. Please try again.",
    network: "Could not reach the server. Check your connection and try again.",
    rateLimited: "You are sending messages too quickly. Please wait a moment and try again.",
    turnInProgress: "The assistant is still answering your previous message.",
    notFound: "This conversation no longer exists. Please start a new conversation.",
    validation: "Your message could not be accepted. Please shorten it and try again.",
    payloadTooLarge: "Your message is too long. Please shorten it and try again.",
    stepLimit: "The assistant could not finish in the allowed number of steps. Please rephrase or add details.",
    maxTokens: "The answer was cut short. Please ask the assistant to continue.",
    refusal: "The assistant could not answer this request. Please rephrase or ask something else.",
    upstream: "The AI service is temporarily unavailable. Please try again.",
    upstreamUnavailable: "The AI service is not available on this server right now.",
    conversationLoad: "Could not restore your previous conversation.",
  },
  localeToggle: { label: "Language", switchTo: "العربية" },
  disclaimer:
    "HealTrip Assistant provides general guidance only and is not a medical device. In an emergency, call your local emergency services immediately.",
  messagesRegion: "Conversation",
  composerLabel: "Your message",
} as const;

export type Dictionary = {
  readonly [K in keyof typeof en]: (typeof en)[K] extends (...args: infer A) => string
    ? (...args: A) => string
    : (typeof en)[K] extends readonly string[]
      ? readonly string[]
      : (typeof en)[K] extends Record<string, string>
        ? { readonly [P in keyof (typeof en)[K]]: string }
        : string;
};

const ar: Dictionary = {
  title: "هيل تريب",
  subtitle: "مساعد المريض الذكي لاتخاذ القرار",
  tagline:
    "صِف ما تشعر به وسيساعدك المساعد على تحديد الخطوة التالية: زيارة طبيب مختص، أو التوجه إلى الطوارئ، أو طلب رأي طبي ثانٍ.",
  placeholder: "صِف أعراضك، ومنذ متى بدأت، وأين تقيم حاليًا…",
  send: "إرسال",
  cancel: "إيقاف",
  newConversation: "محادثة جديدة",
  you: "أنت",
  assistant: "المساعد",
  thinking: "جارٍ التفكير…",
  retry: "إعادة المحاولة",
  startNewHint: "لا يمكن متابعة هذه المحادثة. يرجى بدء محادثة جديدة.",
  charCount: (used, max) => `${used} / ${max}`,
  listSeparator: "، ",
  toolActivity: "ما تحقق منه المساعد",
  samplePromptsTitle: "جرّب مثالًا",
  samplePrompts: [
    "أشعر بألم في الصدر ولست متأكدًا هل أراجع طبيب قلب، أم أتوجه إلى الطوارئ، أم أطلب رأيًا طبيًا ثانيًا.",
    "ابنتي عمرها ست سنوات ولديها حمى 39 درجة منذ يومين مع طفح جلدي على الصدر. نحن في دبي.",
    "شُخّصت بانزلاق غضروفي في القاهرة وأريد رأيًا ثانيًا من استشاري عظام يتحدث الإنجليزية.",
  ],
  toolLabels: {
    assess_urgency: "تقييم درجة الاستعجال",
    search_providers: "البحث عن مقدمي الرعاية",
    get_provider_details: "تحميل تفاصيل مقدم الرعاية",
    recommend_next_step: "إعداد التوصية",
  },
  toolStatus: { running: "قيد التنفيذ", ok: "اكتمل", error: "فشل" },
  nextStepLabels: {
    emergency_now: "توجّه إلى الطوارئ فورًا",
    urgent_care_24h: "اطلب رعاية عاجلة خلال 24 ساعة",
    specialist_consultation: "احجز استشارة مع طبيب مختص",
    second_opinion: "اطلب رأيًا طبيًا ثانيًا",
    primary_care: "راجع طبيب الرعاية الأولية",
    self_care_monitor: "رعاية ذاتية مع المتابعة",
  },
  urgencyLabels: {
    emergency: "حالة طارئة",
    urgent: "عاجل",
    routine: "اعتيادي",
    self_care: "رعاية ذاتية",
  },
  recommendation: {
    title: "الخطوة التالية الموصى بها",
    urgency: "درجة الاستعجال",
    rationale: "السبب",
    questionsRemaining: "لتحسين هذه التوصية، يفيدنا معرفة",
    providers: "مقدمو الرعاية المناسبون من قاعدة بياناتنا",
    noProviders: "لم يُرفق أي مقدم رعاية بهذه التوصية.",
    disclaimer:
      "هذا دعم لاتخاذ القرار وليس تشخيصًا طبيًا، ولا يغني عن الفحص لدى طبيب مرخّص.",
  },
  emergencyBanner: {
    title: "قد تكون هذه حالة طارئة",
    body: "اتصل بخدمات الطوارئ المحلية الآن أو توجّه إلى أقرب قسم طوارئ. لا تنتظر إجابة هذا المساعد.",
  },
  provider: {
    emergencyCapable: "رعاية طارئة",
    telemedicine: "طب عن بُعد",
    acceptsInternational: "يستقبل المرضى الدوليين",
    rating: "التقييم",
    languages: "اللغات",
    specialties: "التخصصات",
  },
  providerKind: {
    hospital: "مستشفى",
    clinic: "عيادة",
    doctor: "طبيب",
  },
  priceTier: {
    low: "اقتصادي",
    mid: "متوسط",
    high: "مرتفع",
  },
  languages: {
    en: "الإنجليزية",
    ar: "العربية",
    tr: "التركية",
    de: "الألمانية",
    fr: "الفرنسية",
  },
  specialties: {
    cardiology: "أمراض القلب",
    neurology: "الأعصاب",
    orthopedics: "العظام",
    oncology: "الأورام",
    dermatology: "الجلدية",
    gastroenterology: "الجهاز الهضمي",
    general_practice: "طب عام",
    emergency_medicine: "طب الطوارئ",
    pediatrics: "طب الأطفال",
    psychiatry: "الطب النفسي",
    ophthalmology: "العيون",
    dentistry: "طب الأسنان",
    pulmonology: "الأمراض الصدرية",
    endocrinology: "الغدد الصماء",
  },
  errors: {
    generic: "حدث خطأ ما. يرجى المحاولة مرة أخرى.",
    timeout: "توقف المساعد عن الاستجابة. يرجى المحاولة مرة أخرى.",
    network: "تعذّر الوصول إلى الخادم. تحقق من اتصالك ثم حاول مجددًا.",
    rateLimited: "أنت ترسل الرسائل بسرعة كبيرة. يرجى الانتظار قليلًا ثم المحاولة مجددًا.",
    turnInProgress: "لا يزال المساعد يجيب عن رسالتك السابقة.",
    notFound: "هذه المحادثة لم تعد موجودة. يرجى بدء محادثة جديدة.",
    validation: "تعذّر قبول رسالتك. يرجى اختصارها والمحاولة مجددًا.",
    payloadTooLarge: "رسالتك طويلة جدًا. يرجى اختصارها والمحاولة مجددًا.",
    stepLimit: "لم يتمكن المساعد من الانتهاء ضمن عدد الخطوات المسموح. يرجى إعادة الصياغة أو إضافة تفاصيل.",
    maxTokens: "انقطعت الإجابة قبل اكتمالها. يرجى الطلب من المساعد المتابعة.",
    refusal: "لم يتمكن المساعد من الإجابة عن هذا الطلب. يرجى إعادة الصياغة أو طرح سؤال آخر.",
    upstream: "خدمة الذكاء الاصطناعي غير متاحة مؤقتًا. يرجى المحاولة مرة أخرى.",
    upstreamUnavailable: "خدمة الذكاء الاصطناعي غير متاحة على هذا الخادم حاليًا.",
    conversationLoad: "تعذّر استعادة محادثتك السابقة.",
  },
  localeToggle: { label: "اللغة", switchTo: "English" },
  disclaimer:
    "يقدّم مساعد هيل تريب إرشادات عامة فقط وليس جهازًا طبيًا. في الحالات الطارئة اتصل بخدمات الطوارئ المحلية فورًا.",
  messagesRegion: "المحادثة",
  composerLabel: "رسالتك",
};

export const dictionaries: Record<Locale, Dictionary> = { en, ar };
