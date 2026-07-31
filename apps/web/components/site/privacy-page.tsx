import { LegalPage } from "@/components/site/legal-page";
import { BRAND_CONTACT_EMAIL, BRAND_NAME } from "@/lib/config";

export function PrivacyPage() {
  return (
    <LegalPage
      title="Self-Hosted Privacy Notice"
      description={`This notice describes the default data boundary of the open-source ${BRAND_NAME} application. The person or organization operating a deployment must publish the privacy policy that applies to its users.`}
      sections={[
        [
          "Local operator control",
          `The open-source ${BRAND_NAME} application runs on infrastructure chosen by its operator. Merely installing or running it does not send accounts, API inputs, memories, documents, or usage logs to the FishMem maintainers.`,
        ],
        [
          "Data stored by a deployment",
          "A deployment can store account and session records, hashed API credentials, workspace settings, memory inputs and derived records, source documents, operation state, request logs, and webhook delivery records. The operator controls the databases, object storage, backups, retention, and access policies.",
        ],
        [
          "Configured providers",
          "Memory inference, embeddings, email, document extraction, and other optional integrations may send data to providers configured by the operator. Their terms and privacy policies apply. Operators should use local providers or disable inference where content must not leave their infrastructure.",
        ],
        [
          "Logs, retention, and deletion",
          "Operators decide what is logged, how long data and backups are retained, and how user requests for access, correction, export, or deletion are handled. FishMem provides inspection, export, and deletion capabilities, but the operator is responsible for applying them across its full deployment and backup policy.",
        ],
        [
          "Security responsibilities",
          "Operators are responsible for TLS, secrets, provider credentials, network access, database and object-storage permissions, software updates, incident response, and any legal basis or consent required for personal or sensitive data.",
        ],
        [
          "FishMem-operated services",
          "FishMem Cloud and any FishMem-operated demonstration service have separate service terms and privacy disclosures. This self-hosted notice does not replace those policies or an operator's own notices.",
        ],
        [
          "Contact",
          `Questions about the open-source software can be sent to ${BRAND_CONTACT_EMAIL}. Privacy requests for a self-hosted deployment must be directed to that deployment's operator.`,
        ],
      ]}
    />
  );
}
