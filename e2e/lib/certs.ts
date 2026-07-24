import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface StubCertificate {
  certificatePath: string;
  keyPath: string;
  certificatePem: string;
  keyPem: string;
}

/**
 * One self-signed certificate covers every host the harness impersonates. It
 * doubles as the trust anchor handed to the spawned services through
 * `NODE_EXTRA_CA_CERTS`, so no real CA and no machine trust store is touched.
 */
export function ensureStubCertificate(
  directory: string,
  hostnames: readonly string[],
): StubCertificate {
  const certificatePath = join(directory, "stub-cert.pem");
  const keyPath = join(directory, "stub-key.pem");
  if (!existsSync(certificatePath) || !existsSync(keyPath)) {
    const subjectAltName = [
      ...hostnames.map((hostname) => `DNS:${hostname}`),
      "DNS:localhost",
      "IP:127.0.0.1",
      "IP:::1",
    ].join(",");
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        keyPath,
        "-out",
        certificatePath,
        "-days",
        "2",
        "-subj",
        "/CN=BuildLabs journey stub",
        "-addext",
        `subjectAltName=${subjectAltName}`,
        "-addext",
        "basicConstraints=critical,CA:TRUE",
      ],
      { stdio: "pipe" },
    );
  }
  return {
    certificatePath,
    keyPath,
    certificatePem: readFileSync(certificatePath, "utf8"),
    keyPem: readFileSync(keyPath, "utf8"),
  };
}
