// Infrastructure compliance checker — verifies that actual cloud resources match
// the tenant's configured data_residency_zone.
// Never throws — always returns a result object.

const REGION_TO_ZONE = {
  "ap-south-1": "india",
  "ap-south-2": "india",
  "eu-west-1": "eu",
  "eu-west-2": "eu",
  "eu-central-1": "eu",
  "us-east-1": "us",
  "us-east-2": "us",
  "us-west-1": "us",
  "us-west-2": "us"
};

function regionToZone(region) {
  // Strip AZ suffix: ap-south-1a → ap-south-1
  const base = region?.replace(/[a-z]$/, "") ?? region;
  return REGION_TO_ZONE[base] ?? "global";
}

// ── Mock backend ─────────────────────────────────────────────────

function runMockCheck(configuredZone) {
  const checkedAt = new Date();
  if (configuredZone === "global") {
    return {
      compliant: true,
      detected_zone: "global",
      configured_zone: configuredZone,
      checks: [{ resource: "mock", region: "global", zone: "global", compliant: true }],
      checked_at: checkedAt
    };
  }
  return {
    compliant: false,
    reason: "Mock mode — infrastructure not verified",
    detected_zone: null,
    configured_zone: configuredZone,
    checks: [{ resource: "mock", region: "mock-region", zone: null, compliant: false }],
    checked_at: checkedAt
  };
}

// ── AWS backend ──────────────────────────────────────────────────

async function runAWSCheck(configuredZone) {
  const checkedAt = new Date();
  const checks = [];

  const makeClient = async (ClientClass) => {
    return new ClientClass({
      region: process.env.AWS_REGION ?? "ap-south-1",
      ...(process.env.AWS_ACCESS_KEY_ID
        ? {
            credentials: {
              accessKeyId: process.env.AWS_ACCESS_KEY_ID,
              secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? ""
            }
          }
        : {})
    });
  };

  // Check 1: RDS instance region
  try {
    const { RDSClient, DescribeDBInstancesCommand } = await import("@aws-sdk/client-rds");
    const rds = await makeClient(RDSClient);
    const dbInstanceId = process.env.DB_INSTANCE_ID;
    const params = dbInstanceId ? { DBInstanceIdentifier: dbInstanceId } : {};
    const res = await rds.send(new DescribeDBInstancesCommand(params));
    const instance = res.DBInstances?.[0];
    const az = instance?.AvailabilityZone ?? "";
    const region = az.replace(/[a-z]$/, "");
    const zone = regionToZone(region);
    checks.push({ resource: "rds", region, zone, compliant: zone === configuredZone });
  } catch (err) {
    checks.push({ resource: "rds", region: null, zone: null, compliant: false, error: err.message });
  }

  // Check 2: S3 bucket region
  try {
    const { S3Client, GetBucketLocationCommand } = await import("@aws-sdk/client-s3");
    const s3 = await makeClient(S3Client);
    const bucket = process.env.S3_BUCKET;
    if (bucket) {
      const res = await s3.send(new GetBucketLocationCommand({ Bucket: bucket }));
      const region = res.LocationConstraint ?? "us-east-1";
      const zone = regionToZone(region);
      checks.push({ resource: "s3", region, zone, compliant: zone === configuredZone });
    } else {
      checks.push({ resource: "s3", region: null, zone: null, compliant: false, error: "S3_BUCKET not configured" });
    }
  } catch (err) {
    checks.push({ resource: "s3", region: null, zone: null, compliant: false, error: err.message });
  }

  // Check 3: compute region from env (ECS/EC2 sets AWS_REGION)
  const computeRegion = process.env.AWS_REGION ?? null;
  const computeZone = computeRegion ? regionToZone(computeRegion) : null;
  checks.push({
    resource: "compute",
    region: computeRegion,
    zone: computeZone,
    compliant: computeZone === configuredZone
  });

  const allCompliant = checks.every((c) => c.compliant);
  const detectedRegions = [...new Set(checks.map((c) => c.region).filter(Boolean))];
  const detectedZone = checks[0]?.zone ?? computeZone ?? null;

  return { compliant: allCompliant, detected_zone: detectedZone, configured_zone: configuredZone, checks, checked_at: checkedAt };
}

// ── GCP backend ──────────────────────────────────────────────────

async function runGCPCheck(configuredZone) {
  const checkedAt = new Date();
  const checks = [];

  // Check 1: compute region via metadata server
  try {
    const res = await fetch("http://metadata.google.internal/computeMetadata/v1/instance/zone", {
      headers: { "Metadata-Flavor": "Google" }
    });
    if (!res.ok) throw new Error(`Metadata server returned ${res.status}`);
    const zoneStr = await res.text();
    // Format: projects/123456/zones/asia-south1-a
    const parts = zoneStr.split("/");
    const az = parts[parts.length - 1] ?? zoneStr;
    const region = az.replace(/-[a-z]$/, "");
    const zone = regionToZone(region);
    checks.push({ resource: "compute", region, zone, compliant: zone === configuredZone });
  } catch (err) {
    checks.push({ resource: "compute", region: null, zone: null, compliant: false, error: err.message });
  }

  // Check 2: GCS bucket location (optional — only if GCS_BUCKET configured)
  const gcsBucket = process.env.GCS_BUCKET;
  if (gcsBucket) {
    try {
      const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
      const tokenRes = await fetch(
        `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(gcsBucket)}?fields=location`,
        credPath ? {} : {}
      );
      if (!tokenRes.ok) throw new Error(`GCS API returned ${tokenRes.status}`);
      const data = await tokenRes.json();
      const gcpRegion = (data.location ?? "").toLowerCase();
      const zone = regionToZone(gcpRegion);
      checks.push({ resource: "gcs", region: gcpRegion, zone, compliant: zone === configuredZone });
    } catch (err) {
      checks.push({ resource: "gcs", region: null, zone: null, compliant: false, error: err.message });
    }
  }

  const allCompliant = checks.length > 0 && checks.every((c) => c.compliant);
  const detectedZone = checks[0]?.zone ?? null;
  return { compliant: allCompliant, detected_zone: detectedZone, configured_zone: configuredZone, checks, checked_at: checkedAt };
}

// ── Public API ───────────────────────────────────────────────────

export async function runComplianceCheck(tenantId, configuredZone) {
  const backend = process.env.INFRA_BACKEND ?? "mock";
  const zone = configuredZone ?? "global";

  try {
    if (backend === "aws") return await runAWSCheck(zone);
    if (backend === "gcp") return await runGCPCheck(zone);
    return runMockCheck(zone);
  } catch (err) {
    console.error(`[infra-compliance] Check failed for tenant ${tenantId}:`, err);
    return {
      compliant: false,
      reason: "CHECK_FAILED",
      error: err.message,
      configured_zone: zone,
      detected_zone: null,
      checks: [],
      checked_at: new Date()
    };
  }
}
