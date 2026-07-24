export interface CustomerEmailDraft {
  subject: string;
  text: string;
  html: string;
  replyTo: string;
}

interface CommonEmailInput {
  customerName: string;
  projectTitle: string;
  replyTo: string;
}

export interface ProposalEmailInput extends CommonEmailInput {
  proposalVersion: number;
  proposalDigest: string;
  summary: string;
  scopeItems: string[];
  hardRequirements: string[];
  preferences: string[];
  supportedFacts: string[];
  exclusions: string[];
  unknowns: string[];
  verificationSummary: string;
  amountMinor: number;
  currency: string;
  checkoutUrl: string;
}

export function proposalEmail(input: ProposalEmailInput): CustomerEmailDraft {
  const price = formatMinorAmount(input.amountMinor, input.currency);
  const lines = [
    `Hi ${input.customerName},`,
    "",
    `Here is proposal v${input.proposalVersion} for ${input.projectTitle}.`,
    "",
    input.summary,
    "",
    "Planned scope:",
    ...input.scopeItems.map((item) => `- ${item}`),
    "",
    "Hard acceptance requirements:",
    ...listOrNone(input.hardRequirements),
    "",
    "Preferences:",
    ...listOrNone(input.preferences),
    "",
    "Supported business facts:",
    ...listOrNone(input.supportedFacts),
    "",
    "Excluded or forbidden claims:",
    ...listOrNone(input.exclusions),
    "",
    "Open items:",
    ...listOrNone(input.unknowns),
    "",
    `Verification plan: ${input.verificationSummary}`,
    `Exact proposal digest: ${input.proposalDigest}`,
    "",
    `Agreed price: ${price}`,
    `Pay for this exact proposal version: ${input.checkoutUrl}`,
    `Payment confirms approval of every displayed item in proposal v${input.proposalVersion} with digest ${input.proposalDigest}.`,
    "",
    "Need a change before paying? Please reply to this email. We will send a new version and replacement payment link; payment for an older version never approves newer scope.",
  ];
  return emailDraft(
    `Proposal v${input.proposalVersion}: ${input.projectTitle}`,
    lines,
    input.replyTo,
  );
}

function listOrNone(items: string[]): string[] {
  return items.length > 0 ? items.map((item) => `- ${item}`) : ["- None"];
}

export interface PaymentConfirmationEmailInput extends CommonEmailInput {
  proposalVersion: number;
}

export interface ClarificationEmailInput {
  customerName?: string;
  questions: string[];
  replyTo: string;
}

export function clarificationEmail(
  input: ClarificationEmailInput,
): CustomerEmailDraft {
  return emailDraft(
    "A few details before we prepare your proposal",
    [
      `Hi ${input.customerName ?? "there"},`,
      "",
      "Please reply with the following details so we can prepare an evidence-backed proposal:",
      ...input.questions.map((question) => `- ${question}`),
      "",
      "We will not guess missing identity, scope, business facts, or pricing.",
    ],
    input.replyTo,
  );
}

export interface EmailVerificationEmailInput {
  customerName?: string;
  verificationUrl: string;
  replyTo: string;
}

export function emailVerificationEmail(
  input: EmailVerificationEmailInput,
): CustomerEmailDraft {
  const verificationUrl = requireCustomerHttpsUrl(input.verificationUrl);
  return emailDraft(
    "Verify your email to continue",
    [
      `Hi ${input.customerName ?? "there"},`,
      "",
      "Use this passwordless link to verify your email and continue your project:",
      verificationUrl,
      "",
      "The link is bound to this project and does not require a password.",
    ],
    input.replyTo,
  );
}

export interface CustomerDashboardLoginEmailInput {
  customerName?: string;
  dashboardUrl: string;
  emailVerified: boolean;
  replyTo: string;
}

export function customerDashboardLoginEmail(
  input: CustomerDashboardLoginEmailInput,
): CustomerEmailDraft {
  const dashboardUrl = requireCustomerHttpsUrl(input.dashboardUrl);
  return emailDraft(
    "Your Buildlapse dashboard sign-in link",
    [
      `Hi ${input.customerName ?? "there"},`,
      "",
      "Use this passwordless link to open your project dashboard:",
      dashboardUrl,
      "",
      input.emailVerified
        ? "The link is bound to your verified email and does not require a password."
        : "The link is bound to the email captured for this project and will verify it when used. No password is required.",
    ],
    input.replyTo,
  );
}

export function paymentConfirmationEmail(
  input: PaymentConfirmationEmailInput,
): CustomerEmailDraft {
  return emailDraft(
    `Payment received: ${input.projectTitle} v${input.proposalVersion}`,
    [
      `Hi ${input.customerName},`,
      "",
      `Thank you—we received and verified payment for proposal v${input.proposalVersion} of ${input.projectTitle}.`,
      "",
      "We are preparing the approved version for the isolated build agents. We will send dashboard access after the parallel build batch is dispatched, then email a proven preview after the selected frozen revision passes its build, tests, code review, contract, and unsupported-claim checks.",
      "",
      "You can keep replying in this thread to steer the work. Each accepted edit becomes a new contract version and is verified again before it can replace the proven version.",
    ],
    input.replyTo,
  );
}

export interface DashboardAccessEmailInput extends CommonEmailInput {
  dashboardUrl: string;
}

export function dashboardAccessEmail(
  input: DashboardAccessEmailInput,
): CustomerEmailDraft {
  const dashboardUrl = requireCustomerHttpsUrl(input.dashboardUrl);
  return emailDraft(
    `Build dashboard: ${input.projectTitle}`,
    [
      `Hi ${input.customerName},`,
      "",
      "Your build agents are now working on the approved project.",
      "",
      "Open your passwordless build dashboard:",
      dashboardUrl,
      "",
      "The dashboard is bound to your verified email and shows the live build activity for this project. You can also send steering requests there while the current proven release remains protected.",
    ],
    input.replyTo,
  );
}

export interface ProvenPreviewEmailInput extends CommonEmailInput {
  contractVersion: number;
  previewUrl: string;
  proofSummary: string;
}

export function provenPreviewEmail(
  input: ProvenPreviewEmailInput,
): CustomerEmailDraft {
  return emailDraft(
    `Proven preview v${input.contractVersion}: ${input.projectTitle}`,
    [
      `Hi ${input.customerName},`,
      "",
      `Your frozen, proven preview for contract v${input.contractVersion} is ready:`,
      input.previewUrl,
      "",
      `Verified for this revision: ${input.proofSummary}`,
      "",
      "This link is pinned to the tested revision; it is not a mutable work-in-progress sandbox. Please reply in this thread with any steering request. We will create and prove a new version before sharing or deploying the change.",
    ],
    input.replyTo,
  );
}

export interface ProductionDeliveryEmailInput extends CommonEmailInput {
  contractVersion: number;
  productionUrl: string;
  proofSummary: string;
  proofSummaryUrl: string;
}

export function productionDeliveryEmail(
  input: ProductionDeliveryEmailInput,
): CustomerEmailDraft {
  const proofSummaryUrl = requireCustomerHttpsUrl(input.proofSummaryUrl);
  return emailDraft(
    `Production delivery v${input.contractVersion}: ${input.projectTitle}`,
    [
      `Hi ${input.customerName},`,
      "",
      `The verified production version of ${input.projectTitle} is live:`,
      input.productionUrl,
      "",
      `Verified for this release: ${input.proofSummary}`,
      `Recorded proof summary for this exact release: ${proofSummaryUrl}`,
      "",
      "You can continue to reply in this thread with iteration requests. The current proven production release stays live until a replacement version passes the complete gate.",
    ],
    input.replyTo,
  );
}

function requireCustomerHttpsUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("Customer link must be a valid URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    throw new TypeError("Customer link must be credential-free HTTPS");
  }
  return url.href;
}

export interface SteeringAcceptedEmailInput extends CommonEmailInput {
  contractVersion: number;
  summary: string;
}

export function steeringAcceptedEmail(
  input: SteeringAcceptedEmailInput,
): CustomerEmailDraft {
  return emailDraft(
    `Revision v${input.contractVersion} queued: ${input.projectTitle}`,
    [
      `Hi ${input.customerName},`,
      "",
      `Your in-scope steering request is now contract v${input.contractVersion}.`,
      input.summary,
      "",
      "The current proven release remains unchanged while the build agents implement and re-prove this revision. We will email a new frozen preview when it passes.",
    ],
    input.replyTo,
  );
}

function emailDraft(
  subject: string,
  lines: string[],
  replyTo: string,
): CustomerEmailDraft {
  const text = lines.join("\n");
  const html = lines
    .map((line) => (line ? `<p>${linkify(escapeHtml(line))}</p>` : "<br>"))
    .join("");
  return { subject, text, html, replyTo };
}

function formatMinorAmount(amountMinor: number, currency: string): string {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new RangeError("amountMinor must be a positive safe integer");
  }
  const formatter = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  });
  const fractionDigits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  return formatter.format(amountMinor / 10 ** fractionDigits);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function linkify(value: string): string {
  return value.replace(
    /(https:\/\/[^\s<]+)/g,
    '<a href="$1" rel="noopener noreferrer">$1</a>',
  );
}
