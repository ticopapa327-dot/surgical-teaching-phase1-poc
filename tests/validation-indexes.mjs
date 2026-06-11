import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requiredStrictStepIds = [
  "lan-topology",
  "lan-route-plan",
  "117-probe",
  "117-signal",
  "117-media",
  "117-audio",
  "117-media-diagnostics",
  "117-audio-diagnostics",
  "137-probe",
  "137-signal",
  "137-media",
  "137-audio",
  "137-media-diagnostics",
  "137-audio-diagnostics",
  "117-137-conference"
];

function sha256(textOrBuffer) {
  return crypto.createHash("sha256").update(textOrBuffer).digest("hex");
}

function resourceSnapshot(label) {
  return {
    label,
    capturedAt: "2026-06-11T00:00:01.000Z",
    memory: {
      totalGiB: 32,
      freeGiB: 20,
      freePercent: 62.5
    },
    system: {
      ok: true,
      capturedAt: "2026-06-11T00:00:01.000Z",
      cpu: {
        logicalProcessors: 16,
        loadPercent: 12.5
      },
      memory: {
        totalGiB: 32,
        freeGiB: 20,
        freePercent: 62.5
      },
      processes: []
    }
  };
}

async function writeJsonWithChecksum(filePath, value) {
  const json = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(filePath, json, "utf8");
  await writeFile(filePath.replace(/\.json$/i, ".sha256"), `${sha256(json)}  ${path.basename(filePath)}\n`, "utf8");
}

function splitRouteDiscovery() {
  return {
    ok: false,
    matchCount: 0,
    knownHostConnectivity: {
      classification: "os-route-open-lan-bound-closed",
      bound: {
        localAddress: "192.168.1.118",
        tcpOpen: false,
        error: "timeout"
      },
      osRoute: {
        tcpOpen: true,
        error: ""
      },
      routeHint: {
        interfaceAlias: "CMYNetwork",
        sourceAddress: "198.19.0.1",
        nextHop: "198.19.0.2"
      },
      routeOnExpectedLan: false,
      warnings: ["known host 192.168.1.137:22 is reachable only without LAN bind"]
    },
    warnings: ["known host 192.168.1.137:22 is not reachable from local address 192.168.1.118"]
  };
}

async function writeCrossReport(
  reportDir,
  id,
  {
    ok = true,
    withArtifact = true,
    strict = false,
    steps = null,
    kylinDiscovery = null,
    windowsLanTargets = [],
    lanTopology = null
  } = {}
) {
  const artifactDir = path.join(reportDir, `${id}-artifacts`);
  const artifactPath = path.join(artifactDir, "snapshot.json");
  const manifestPath = path.join(artifactDir, "artifact-manifest.json");
  let artifactArchive = null;

  if (withArtifact) {
    await mkdir(artifactDir, { recursive: true });
    const files = [];
    const artifactJson = `${JSON.stringify({ id, kind: "snapshot" }, null, 2)}\n`;
    await writeFile(artifactPath, artifactJson, "utf8");
    files.push({
      sourcePath: "test-results/example/snapshot.json",
      targetPath: artifactPath,
      bytes: Buffer.byteLength(artifactJson),
      sha256: sha256(artifactJson)
    });

    if (strict) {
      const lanTopologyPath = path.join(artifactDir, "remote-lan-topology", "lan-topology.json");
      const lanRoutePlanPath = path.join(
        artifactDir,
        "cross-machine-validation",
        "lan-route-remediation-plan.md"
      );
      const windowsProbePath = path.join(artifactDir, "remote-windows-probe", "windows-probe.json");
      const kylinProbePath = path.join(artifactDir, "remote-kylin-probe", "kylin-probe.json");
      const lanTopologyJson = `${JSON.stringify(
        lanTopology || {
          ok: true,
          bothProbesOk: true,
          topologyOk: true,
          diagnosis: {
            classification: "ok",
            blocking: false,
            evidence: [],
            recommendations: []
          },
          warnings: [],
          local: {
            probe: {
              routeHint: { interfaceAlias: "以太网 2", sourceAddress: "192.168.1.118" },
              tcp: { bound: { ok: true } }
            }
          },
          remoteWindows: {
            probe: {
              routeHint: { interfaceAlias: "WLAN", sourceAddress: "192.168.1.117" },
              tcp: { bound: { ok: true } }
            }
          }
        },
        null,
        2
      )}\n`;
      const lanRoutePlanClassification = lanTopology?.diagnosis?.classification || "ok";
      const lanRoutePlanRequiresManualAction = lanTopology?.topologyOk === false ? "true" : "false";
      const lanRoutePlanText = [
        "# LAN route remediation plan",
        "",
        "Generated at: 2026-06-11T00:00:01.000Z",
        "Source artifact: test-results/remote-lan-topology/lan-topology.json",
        `Classification: ${lanRoutePlanClassification}`,
        `Requires manual action: ${lanRoutePlanRequiresManualAction}`,
        ""
      ].join("\n");
      const windowsProbeJson = `${JSON.stringify(
        {
          checks: {
            remote: {
              checks: {
                resources: {
                  capturedAt: "2026-06-11T00:00:01.000Z",
                  memory: { freeGiB: 8 },
                  processes: []
                },
                lanTargets: windowsLanTargets
              }
            }
          }
        },
        null,
        2
      )}\n`;
      const kylinProbeJson = `${JSON.stringify(
        {
          checks: {
            resources: {
              capturedAt: "2026-06-11T00:00:01.000Z",
              memory: { availableGiB: 8 },
              processes: []
            }
          }
        },
        null,
        2
      )}\n`;
      await mkdir(path.dirname(lanTopologyPath), { recursive: true });
      await mkdir(path.dirname(lanRoutePlanPath), { recursive: true });
      await mkdir(path.dirname(windowsProbePath), { recursive: true });
      await mkdir(path.dirname(kylinProbePath), { recursive: true });
      await writeFile(lanTopologyPath, lanTopologyJson, "utf8");
      await writeFile(lanRoutePlanPath, lanRoutePlanText, "utf8");
      await writeFile(windowsProbePath, windowsProbeJson, "utf8");
      await writeFile(kylinProbePath, kylinProbeJson, "utf8");
      files.push(
        {
          sourcePath: "test-results/remote-lan-topology/lan-topology.json",
          targetPath: lanTopologyPath,
          bytes: Buffer.byteLength(lanTopologyJson),
          sha256: sha256(lanTopologyJson)
        },
        {
          sourcePath: "validation-results/cross-machine-validation/lan-route-remediation-plan.md",
          targetPath: lanRoutePlanPath,
          bytes: Buffer.byteLength(lanRoutePlanText),
          sha256: sha256(lanRoutePlanText)
        },
        {
          sourcePath: "test-results/remote-windows-probe/windows-probe.json",
          targetPath: windowsProbePath,
          bytes: Buffer.byteLength(windowsProbeJson),
          sha256: sha256(windowsProbeJson)
        },
        {
          sourcePath: "test-results/remote-kylin-probe/kylin-probe.json",
          targetPath: kylinProbePath,
          bytes: Buffer.byteLength(kylinProbeJson),
          sha256: sha256(kylinProbeJson)
        }
      );
    }

    if (kylinDiscovery) {
      const kylinDiscoveryPath = path.join(artifactDir, "remote-kylin-discovery", "kylin-discovery.json");
      const kylinDiscoveryJson = `${JSON.stringify(kylinDiscovery, null, 2)}\n`;
      await mkdir(path.dirname(kylinDiscoveryPath), { recursive: true });
      await writeFile(kylinDiscoveryPath, kylinDiscoveryJson, "utf8");
      files.push({
        sourcePath: "test-results/remote-kylin-discovery/kylin-discovery.json",
        targetPath: kylinDiscoveryPath,
        bytes: Buffer.byteLength(kylinDiscoveryJson),
        sha256: sha256(kylinDiscoveryJson)
      });
    }

    const manifest = {
      artifactsDir: artifactDir,
      createdAt: "2026-06-11T00:00:01.000Z",
      sourceMtimeNotBefore: "2026-06-11T00:00:00.000Z",
      fileCount: files.length,
      files
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    artifactArchive = {
      artifactsDir: artifactDir,
      manifestPath: manifestPath,
      fileCount: files.length
    };
  }

  const report = {
    ok,
    startedAt: `2026-06-11T00:00:${id.endsWith("fail") ? "02" : "01"}.000Z`,
    finishedAt: `2026-06-11T00:00:${id.endsWith("fail") ? "03" : "02"}.000Z`,
    config: strict
      ? {
          strictRemoteCoverage: true,
          requireWindows117: true,
          requireKylin137: true,
          requireConference: true,
          skipWindows117: false,
          skipKylin137: false
        }
      : {},
    healthClean: true,
    healthAfter: {
      ok: true,
      endpoints: 0,
      sessions: 0,
      pendingCalls: 0
    },
    systemResources: {
      before: resourceSnapshot("before"),
      after: resourceSnapshot("after")
    },
    artifactArchive,
    steps:
      steps ||
      (strict
        ? requiredStrictStepIds.map((stepId) => ({
            id: stepId,
            status: ok ? "passed" : "failed",
            attemptCount: 1,
            maxAttempts: 1
          }))
        : [
            {
              id: ok ? "117-signal" : "137-signal",
              status: ok ? "passed" : "failed",
              attemptCount: 1,
              maxAttempts: 1
            }
          ])
  };
  const reportPath = path.join(reportDir, `${id}.json`);
  await writeJsonWithChecksum(reportPath, report);
  return { report, reportPath };
}

async function writeContinuousLedger(
  reportDir,
  id,
  crossReportPath,
  {
    ok = true,
    crossScript = "test:remote:cross:strict",
    finishedAt = "2026-06-11T00:02:00.000Z",
    strictPostChecks = crossScript === "test:remote:cross:strict",
    skipResourceIndex = false,
    skipStatusGate = false,
    resourceIndexStatus = "passed",
    statusGateStatus = "passed"
  } = {}
) {
  const ledger = {
    id,
    ok,
    startedAt: "2026-06-11T00:01:00.000Z",
    finishedAt,
    stopReason: "iteration limit reached",
    config: {
      reportDir,
      crossScript,
      iterations: 1,
      durationMs: 0,
      intervalSeconds: 1,
      stopOnFailure: false,
      strictPostChecks,
      skipResourceIndex,
      skipStatusGate
    },
    cycles: [
      {
        iteration: 1,
        ok,
        startedAt: "2026-06-11T00:01:00.000Z",
        finishedAt: "2026-06-11T00:02:00.000Z",
        durationMs: 60000,
        cross: {
          status: ok ? "passed" : "failed"
        },
        index: {
          status: "passed"
        },
        resourceIndex: skipResourceIndex
          ? null
          : {
              status: resourceIndexStatus
            },
        statusGate:
          strictPostChecks && !skipStatusGate
            ? {
                status: statusGateStatus
              }
            : null,
        crossReport: {
          reportPath: crossReportPath,
          ok
        }
      }
    ]
  };
  const ledgerPath = path.join(reportDir, `${id}.json`);
  await writeJsonWithChecksum(ledgerPath, ledger);
  return { ledger, ledgerPath };
}

function runNode(script, env, args = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, "--json", "--no-write", ...args], {
      cwd: rootDir,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

const tempDir = await mkdtemp(path.join(os.tmpdir(), "ust-validation-indexes-"));

try {
  const reportDir = path.join(tempDir, "reports-ok");
  await mkdir(reportDir, { recursive: true });
  const pass = await writeCrossReport(reportDir, "2026-06-11T00-00-01-000Z");
  await writeCrossReport(reportDir, "2026-06-11T00-00-02-000Z-fail", {
    ok: false,
    kylinDiscovery: splitRouteDiscovery()
  });
  await writeFile(path.join(reportDir, "status.json"), `${JSON.stringify({ ok: true }, null, 2)}\n`, "utf8");
  await writeContinuousLedger(reportDir, "continuous-2026-06-11T00-01-00-000Z", pass.reportPath);

  const crossIndex = await runNode("scripts/validation-report-index.cjs", {
    UST_VALIDATION_REPORT_DIR: reportDir
  });
  assert.equal(crossIndex.code, 0, `${crossIndex.stdout}\n${crossIndex.stderr}`);
  const crossIndexJson = JSON.parse(crossIndex.stdout);
  assert.equal(crossIndexJson.totalReports, 2);
  assert.equal(crossIndexJson.passingReports, 1);
  assert.equal(crossIndexJson.failingReports, 1);
  assert.equal(crossIndexJson.evidenceFailures, 0);
  assert.equal(crossIndexJson.reports.some((report) => report.id.startsWith("continuous-")), false);
  const failedReportIndex = crossIndexJson.reports.find((report) => report.id.endsWith("fail"));
  assert.equal(failedReportIndex.kylinDiscovery.available, true);
  assert.equal(failedReportIndex.kylinDiscovery.classification, "os-route-open-lan-bound-closed");
  assert.equal(failedReportIndex.kylinDiscovery.boundTcpOpen, false);
  assert.equal(failedReportIndex.kylinDiscovery.osRouteTcpOpen, true);

  const continuousIndex = await runNode("scripts/continuous-validation-index.cjs", {
    UST_VALIDATION_REPORT_DIR: reportDir
  });
  assert.equal(continuousIndex.code, 0, `${continuousIndex.stdout}\n${continuousIndex.stderr}`);
  const continuousIndexJson = JSON.parse(continuousIndex.stdout);
  assert.equal(continuousIndexJson.totalLedgers, 1);
  assert.equal(continuousIndexJson.passingLedgers, 1);
  assert.equal(continuousIndexJson.evidenceFailures, 0);
  assert.equal(continuousIndexJson.ledgers[0].cycles[0].crossReport.reportOk, true);
  assert.equal(continuousIndexJson.ledgers[0].cycles[0].crossReport.artifacts.ok, true);
  assert.equal(continuousIndexJson.ledgers[0].cycles[0].postChecks.ok, true);

  const failedPostCheckDir = path.join(tempDir, "continuous-post-check-failed");
  await mkdir(failedPostCheckDir, { recursive: true });
  const failedPostCheckReport = await writeCrossReport(failedPostCheckDir, "2026-06-11T00-02-00-000Z", {
    strict: true
  });
  await writeContinuousLedger(
    failedPostCheckDir,
    "continuous-2026-06-11T00-02-30-000Z",
    failedPostCheckReport.reportPath,
    { statusGateStatus: "failed" }
  );
  const failedPostCheckIndex = await runNode("scripts/continuous-validation-index.cjs", {
    UST_VALIDATION_REPORT_DIR: failedPostCheckDir
  });
  assert.equal(failedPostCheckIndex.code, 0, `${failedPostCheckIndex.stdout}\n${failedPostCheckIndex.stderr}`);
  const failedPostCheckIndexJson = JSON.parse(failedPostCheckIndex.stdout);
  assert.equal(failedPostCheckIndexJson.passingLedgers, 0);
  assert.equal(failedPostCheckIndexJson.failingLedgers, 1);
  assert.equal(failedPostCheckIndexJson.evidenceFailures, 0);
  assert.deepEqual(failedPostCheckIndexJson.ledgers[0].failedCycles, [1]);
  assert.equal(failedPostCheckIndexJson.ledgers[0].cycles[0].postChecks.statusGateOk, false);

  const strictStatusDir = path.join(tempDir, "status-strict-ok");
  await mkdir(strictStatusDir, { recursive: true });
  const strictPass = await writeCrossReport(strictStatusDir, "2026-06-11T00-06-00-000Z", { strict: true });
  await writeContinuousLedger(strictStatusDir, "continuous-2026-06-11T00-06-30-000Z", strictPass.reportPath);
  const strictStatus = await runNode("scripts/validation-status.cjs", {
    UST_VALIDATION_REPORT_DIR: strictStatusDir,
    UST_VALIDATION_STATUS_MAX_AGE_MINUTES: "0"
  });
  assert.equal(strictStatus.code, 0, `${strictStatus.stdout}\n${strictStatus.stderr}`);
  const strictStatusJson = JSON.parse(strictStatus.stdout);
  assert.equal(strictStatusJson.ok, true);
  assert.equal(strictStatusJson.latestStrictLedger.latestCycle.crossStatus, "passed");
  assert.equal(strictStatusJson.latestStrictReport.strictCoverage.ok, true);
  assert.equal(strictStatusJson.latestStrictReport.localResources.ok, true);
  assert.equal(strictStatusJson.latestStrictReport.remoteResources.ok, true);
  assert.equal(strictStatusJson.latestStrictReport.steps.ok, true);
  assert.equal(strictStatusJson.latestStrictReport.artifacts.ok, true);
  assert.equal(strictStatusJson.latestStrictReport.lanRoutePlan.available, true);
  assert.equal(strictStatusJson.latestStrictReport.lanRoutePlan.classification, "ok");
  assert.equal(strictStatusJson.latestStrictReport.lanRoutePlan.requiresManualAction, false);

  const resourceIndex = await runNode(
    "scripts/validation-resource-index.cjs",
    {
      UST_VALIDATION_REPORT_DIR: strictStatusDir
    },
    ["--strict-only"]
  );
  assert.equal(resourceIndex.code, 0, `${resourceIndex.stdout}\n${resourceIndex.stderr}`);
  const resourceIndexJson = JSON.parse(resourceIndex.stdout);
  assert.equal(resourceIndexJson.totalReports, 1);
  assert.equal(resourceIndexJson.reportsWithAllResources, 1);
  assert.equal(resourceIndexJson.reportsWithWarnings, 0);
  assert.equal(resourceIndexJson.machines.local118After.minMemoryFreeGiB, 20);
  assert.equal(resourceIndexJson.machines.windows117.minMemoryFreeGiB, 8);
  assert.equal(resourceIndexJson.machines.kylin137.minMemoryFreeGiB, 8);

  const activeLedgerDir = path.join(tempDir, "status-active-ledger");
  await mkdir(activeLedgerDir, { recursive: true });
  const activeLedgerReport = await writeCrossReport(activeLedgerDir, "2026-06-11T00-06-10-000Z", { strict: true });
  await writeContinuousLedger(
    activeLedgerDir,
    "continuous-2026-06-11T00-06-40-000Z",
    activeLedgerReport.reportPath,
    { finishedAt: "" }
  );
  const activeLedgerStatus = await runNode("scripts/validation-status.cjs", {
    UST_VALIDATION_REPORT_DIR: activeLedgerDir,
    UST_VALIDATION_STATUS_MAX_AGE_MINUTES: "0"
  });
  assert.equal(activeLedgerStatus.code, 0, `${activeLedgerStatus.stdout}\n${activeLedgerStatus.stderr}`);
  const activeLedgerStatusJson = JSON.parse(activeLedgerStatus.stdout);
  assert.equal(activeLedgerStatusJson.latestStrictLedger.finishedAt, "2026-06-11T00:02:00.000Z");

  const noStrictLedgerDir = path.join(tempDir, "status-no-strict-ledger");
  await mkdir(noStrictLedgerDir, { recursive: true });
  const noStrictReport = await writeCrossReport(noStrictLedgerDir, "2026-06-11T00-07-00-000Z", { strict: true });
  await writeContinuousLedger(
    noStrictLedgerDir,
    "continuous-2026-06-11T00-07-30-000Z",
    noStrictReport.reportPath,
    { crossScript: "test:remote:cross" }
  );
  const noStrictStatus = await runNode("scripts/validation-status.cjs", {
    UST_VALIDATION_REPORT_DIR: noStrictLedgerDir,
    UST_VALIDATION_STATUS_MAX_AGE_MINUTES: "0"
  });
  assert.equal(noStrictStatus.code, 1);
  const noStrictStatusJson = JSON.parse(noStrictStatus.stdout);
  assert.equal(noStrictStatusJson.failures.includes("no strict continuous ledger found"), true);

  const splitRouteStatusDir = path.join(tempDir, "status-kylin-split-route");
  await mkdir(splitRouteStatusDir, { recursive: true });
  const splitRouteReport = await writeCrossReport(splitRouteStatusDir, "2026-06-11T00-07-40-000Z", {
    ok: false,
    strict: true,
    kylinDiscovery: splitRouteDiscovery(),
    lanTopology: {
      ok: true,
      bothProbesOk: true,
      topologyOk: false,
      diagnosis: {
        classification: "overlay_route_hijack_and_lan_target_unresolved",
        blocking: true,
        evidence: [
          "default_route_tcp_works_but_lan_bound_tcp_fails",
          "route_source_is_not_expected_lan_on_all_available_probes",
          "target_neighbor_unresolved_on_all_available_probes"
        ],
        recommendations: ["Re-run npm run test:remote:lan:topology before strict cross-machine validation."]
      },
      warnings: [
        "or118_kylin137_route_source_not_expected_lan",
        "or118_kylin137_bound_tcp_unreachable",
        "teach117_kylin137_neighbor_unresolved"
      ],
      local: {
        probe: {
          routeHint: {
            destinationPrefix: "192.168.1.137/32",
            interfaceAlias: "CMYNetwork",
            sourceAddress: "198.19.0.1"
          },
          tcp: { bound: { ok: false } }
        }
      },
      remoteWindows: {
        probe: {
          routeHint: {
            destinationPrefix: "192.168.1.137/32",
            interfaceAlias: "CMYNetwork",
            sourceAddress: "198.19.0.1"
          },
          tcp: { bound: { ok: false } }
        }
      }
    },
    windowsLanTargets: [
      {
        name: "kylin137",
        host: "192.168.1.137",
        port: 22,
        ok: true,
        onExpectedLan: false,
        expectedLanSourcePrefix: "192.168.1.",
        route: {
          interfaceAlias: "CMYNetwork",
          sourceAddress: "198.19.0.1"
        }
      }
    ]
  });
  await writeContinuousLedger(
    splitRouteStatusDir,
    "continuous-2026-06-11T00-07-50-000Z",
    splitRouteReport.reportPath,
    { ok: false }
  );
  const splitRouteStatus = await runNode("scripts/validation-status.cjs", {
    UST_VALIDATION_REPORT_DIR: splitRouteStatusDir,
    UST_VALIDATION_STATUS_MAX_AGE_MINUTES: "0"
  });
  assert.equal(splitRouteStatus.code, 1);
  const splitRouteStatusJson = JSON.parse(splitRouteStatus.stdout);
  assert.equal(
    splitRouteStatusJson.latestStrictReport.kylinDiscovery.classification,
    "os-route-open-lan-bound-closed"
  );
  assert.equal(splitRouteStatusJson.latestStrictReport.kylinDiscovery.routeOnExpectedLan, false);
  assert.equal(splitRouteStatusJson.latestStrictReport.kylinDiscovery.routeHint.interfaceAlias, "CMYNetwork");
  assert.equal(
    splitRouteStatusJson.failures.includes(
      "strict cross report Kylin discovery failed: os-route-open-lan-bound-closed"
    ),
    true
  );
  assert.equal(
    splitRouteStatusJson.failures.includes(
      "strict cross report Kylin discovery OS route is not using expected LAN source"
    ),
    true
  );
  assert.equal(splitRouteStatusJson.latestStrictReport.remoteResources.windowsLanTargetsOk, false);
  assert.equal(splitRouteStatusJson.latestStrictReport.lanTopology.topologyOk, false);
  assert.equal(splitRouteStatusJson.latestStrictReport.lanRoutePlan.available, true);
  assert.equal(
    splitRouteStatusJson.latestStrictReport.lanRoutePlan.classification,
    "overlay_route_hijack_and_lan_target_unresolved"
  );
  assert.equal(splitRouteStatusJson.latestStrictReport.lanRoutePlan.requiresManualAction, true);
  assert.equal(
    splitRouteStatusJson.latestStrictReport.lanTopology.diagnosis.classification,
    "overlay_route_hijack_and_lan_target_unresolved"
  );
  assert.equal(splitRouteStatusJson.latestStrictReport.lanTopology.local.routeInterface, "CMYNetwork");
  assert.equal(splitRouteStatusJson.latestStrictReport.lanTopology.local.routeDestination, "192.168.1.137/32");
  assert.equal(
    splitRouteStatusJson.failures.includes(
      "strict cross report LAN topology check failed: overlay_route_hijack_and_lan_target_unresolved"
    ),
    true
  );
  assert.equal(
    splitRouteStatusJson.failures.includes(
      "strict cross report Windows 117 LAN target route is not on expected LAN"
    ),
    true
  );

  const missingStrictStepDir = path.join(tempDir, "status-missing-strict-step");
  await mkdir(missingStrictStepDir, { recursive: true });
  const missingStepReport = await writeCrossReport(missingStrictStepDir, "2026-06-11T00-08-00-000Z", {
    strict: true,
    steps: requiredStrictStepIds
      .filter((stepId) => stepId !== "117-137-conference")
      .map((stepId) => ({
        id: stepId,
        status: "passed",
        attemptCount: 1,
        maxAttempts: 1
      }))
  });
  await writeContinuousLedger(
    missingStrictStepDir,
    "continuous-2026-06-11T00-08-30-000Z",
    missingStepReport.reportPath
  );
  const missingStepStatus = await runNode("scripts/validation-status.cjs", {
    UST_VALIDATION_REPORT_DIR: missingStrictStepDir,
    UST_VALIDATION_STATUS_MAX_AGE_MINUTES: "0"
  });
  assert.equal(missingStepStatus.code, 1);
  const missingStepStatusJson = JSON.parse(missingStepStatus.stdout);
  assert.equal(missingStepStatusJson.latestStrictReport.steps.missing.includes("117-137-conference"), true);

  const tamperedDir = path.join(tempDir, "reports-tampered");
  await mkdir(tamperedDir, { recursive: true });
  const tampered = await writeCrossReport(tamperedDir, "2026-06-11T00-03-00-000Z");
  const tamperedJson = JSON.parse(await readFile(tampered.reportPath, "utf8"));
  tamperedJson.healthAfter.endpoints = 1;
  await writeFile(tampered.reportPath, `${JSON.stringify(tamperedJson, null, 2)}\n`, "utf8");

  const tamperedIndex = await runNode("scripts/validation-report-index.cjs", {
    UST_VALIDATION_REPORT_DIR: tamperedDir
  });
  assert.equal(tamperedIndex.code, 1);
  const tamperedIndexJson = JSON.parse(tamperedIndex.stdout);
  assert.equal(tamperedIndexJson.evidenceFailures, 1);
  assert.equal(tamperedIndexJson.reports[0].checksum.ok, false);

  const missingCrossDir = path.join(tempDir, "continuous-missing-cross");
  await mkdir(missingCrossDir, { recursive: true });
  await writeContinuousLedger(
    missingCrossDir,
    "continuous-2026-06-11T00-04-00-000Z",
    path.join(missingCrossDir, "missing-cross-report.json")
  );

  const missingCrossIndex = await runNode("scripts/continuous-validation-index.cjs", {
    UST_VALIDATION_REPORT_DIR: missingCrossDir
  });
  assert.equal(missingCrossIndex.code, 1);
  const missingCrossIndexJson = JSON.parse(missingCrossIndex.stdout);
  assert.equal(missingCrossIndexJson.evidenceFailures, 1);
  assert.equal(missingCrossIndexJson.ledgers[0].cycles[0].crossReport.error, "cross report missing");

  const tamperedArtifactDir = path.join(tempDir, "continuous-tampered-artifact");
  await mkdir(tamperedArtifactDir, { recursive: true });
  const artifactTampered = await writeCrossReport(tamperedArtifactDir, "2026-06-11T00-05-00-000Z");
  const artifactPath = path.join(tamperedArtifactDir, "2026-06-11T00-05-00-000Z-artifacts", "snapshot.json");
  await writeFile(artifactPath, `${JSON.stringify({ id: "changed", kind: "snapshot" }, null, 2)}\n`, "utf8");
  await writeContinuousLedger(
    tamperedArtifactDir,
    "continuous-2026-06-11T00-05-30-000Z",
    artifactTampered.reportPath
  );

  const tamperedArtifactIndex = await runNode("scripts/continuous-validation-index.cjs", {
    UST_VALIDATION_REPORT_DIR: tamperedArtifactDir
  });
  assert.equal(tamperedArtifactIndex.code, 1);
  const tamperedArtifactIndexJson = JSON.parse(tamperedArtifactIndex.stdout);
  assert.equal(tamperedArtifactIndexJson.evidenceFailures, 1);
  assert.equal(tamperedArtifactIndexJson.ledgers[0].cycles[0].crossReport.artifacts.hashMismatches, 1);
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

console.log("validation indexes test passed");
