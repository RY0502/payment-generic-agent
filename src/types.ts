/**
 * Shared type definitions for the generic payment agent.
 */

/** Payment details extracted from the user's prompt. All values are strings. */
export interface PaymentData {
  paymentType?: string;
  accountNumber?: string;
  amount?: string;
  mobileNumber?: string;
  email?: string;
  customerName?: string;
  upiId?: string;
  paymentGateway?: string;
  paymentMethod?: string;
  /** Any other identifier the user supplied (e.g. "consumerId", "billerId"). */
  [key: string]: string | undefined;
}

/** Result of interpreting the user's prompt. */
export interface PaymentRequest {
  targetUrl: string;
  paymentData: PaymentData;
}

/** Kind of interactive element detected in a page snapshot. */
export type ElementKind =
  | "input"
  | "textarea"
  | "select"
  | "checkbox"
  | "radio"
  | "button"
  | "link"
  | "tab"
  | "option";

/** A single interactive element discovered by the DOM snapshot. */
export interface SnapshotElement {
  /** Stable reference id (e.g. "e12") also written to the DOM as data-pa-id. */
  id: string;
  kind: ElementKind;
  /** Best human-readable label (label text / aria-label / placeholder / text). */
  label: string;
  /** Raw attributes useful for locator strategies. */
  tag: string;
  type?: string;
  name?: string;
  domId?: string;
  placeholder?: string;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  required?: boolean;
  maxLength?: number;
  options?: string[];
  /** Index of the frame the element lives in (0 = main frame). */
  frame: number;
  /** Whether it lives inside a modal/dialog overlay. */
  inDialog?: boolean;
  /** Whether it lives in page chrome (header / footer / navigation). */
  inChrome?: boolean;
}

/** Full structured view of the current page, produced in ONE pass. */
export interface PageSnapshot {
  url: string;
  title: string;
  headings: string[];
  text: string;
  elements: SnapshotElement[];
  hasCaptcha: boolean;
  hasOtpInputs: boolean;
  otpBoxCount: number;
  hasQrCode: boolean;
  hasDialog: boolean;
  dialogText?: string;
}

/** Optional vision summary of the current screenshot. */
export interface VisionSummary {
  pageType: string;
  summary: string;
  hasCaptcha: boolean;
  isPaymentSuccessPage: boolean;
  hasQrCode: boolean;
}

/** Terminal status of a payment run. */
export type RunStatus = "running" | "success" | "failed";
