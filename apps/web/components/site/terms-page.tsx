import { LegalPage } from "@/components/site/legal-page";
import { BRAND_CONTACT_EMAIL, BRAND_NAME } from "@/lib/config";

export function TermsPage() {
  return (
    <LegalPage
      title="Self-Hosted Software Terms"
      description={`The open-source ${BRAND_NAME} software is licensed under Apache-2.0. The operator of each deployment is responsible for the terms that govern its service.`}
      sections={[
        [
          "Open-source license",
          "Your right to use, modify, and distribute this software is governed by the Apache License 2.0 included with the repository. These pages do not replace or narrow that license.",
        ],
        [
          "Deployment operator",
          "A self-hosted deployment is operated independently from the FishMem maintainers. Its operator controls user access, availability, support, content policies, retention, integrations, and any fees, and must provide any additional terms required for its users.",
        ],
        [
          "Inputs and memory data",
          "Users and operators are responsible for the content they store, the rights and legal basis needed to process it, the scopes used to isolate it, and the outputs retrieved by their applications. Do not process prohibited or regulated data without appropriate controls and authorization.",
        ],
        [
          "Third-party services",
          "Configured model, embedding, email, extraction, storage, and identity providers are independent services. Their terms, pricing, technical limits, and privacy policies apply to data sent to them.",
        ],
        [
          "Security and operations",
          "Operators are responsible for deployment security, secrets, backups, updates, monitoring, abuse prevention, availability, and incident handling. API keys and administrative credentials must be protected and rotated when exposure is suspected.",
        ],
        [
          "Warranty and liability",
          "The software is provided under the warranty and liability terms of the Apache License 2.0. Review that license before using FishMem in production or for sensitive workloads.",
        ],
        [
          "Managed service",
          "FishMem Cloud is a separate managed commercial service with its own terms, privacy policy, plans, and operational commitments. No hosted subscription or payment terms are implied by the open-source application.",
        ],
        [
          "Contact",
          `Questions about the open-source software can be sent to ${BRAND_CONTACT_EMAIL}. Service-specific questions must be directed to the operator of the deployment.`,
        ],
      ]}
    />
  );
}
