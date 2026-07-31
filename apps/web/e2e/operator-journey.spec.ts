import { expect, test } from "@playwright/test";

test.describe.configure({ mode: "serial" });

test("operator setup and core dashboard journey", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await page.goto("/setup");
  if (testInfo.project.name === "chromium") {
    await page.getByLabel("Name").fill("FishMem Operator");
    await page.getByLabel("Email").fill("operator@fishmem.test");
    await page.getByLabel("Password").fill("fishmem-test-password");
    await page
      .getByLabel("Setup token (production only)")
      .fill("fishmem-e2e-setup-token");
    await page.getByRole("button", { name: "Create admin account" }).click();
    const providerStep = page.getByText("Admin account created");
    await expect(providerStep).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByRole("button", { name: "Continue to dashboard" }),
    ).toBeVisible();
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/dashboard/);
  } else {
    await page.goto("/login");
    await page.getByLabel("Email").fill("operator@fishmem.test");
    await page.getByLabel("Password").fill("fishmem-test-password");
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page).toHaveURL(/\/dashboard/);
  }

  if (testInfo.project.name === "chromium") {
    await page.getByRole("link", { name: "Playground", exact: true }).click();
  } else {
    await page.goto("/dashboard/playground");
  }
  await expect(page.getByRole("button", { name: "add" })).toBeVisible();
  await expect(page.getByRole("button", { name: "search" })).toBeVisible();
  await expect(page.getByRole("button", { name: "state" })).toBeVisible();
  await page.getByLabel("Scope id").fill("operator-scope");
  await expect(page.getByLabel("Scope id")).toHaveValue("operator-scope");

  if (testInfo.project.name === "chromium") {
    await page.getByRole("link", { name: "Operations" }).click();
  } else {
    await page.goto("/dashboard/operations");
  }
  await expect(
    page.getByRole("heading", { name: "Operations", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Rebuild projections" })).toBeVisible();

  if (testInfo.project.name === "chromium") {
    await page.getByRole("link", { name: "API Keys" }).click();
  } else {
    await page.goto("/dashboard/api-keys");
  }
  await page.getByRole("button", { name: "New key" }).first().click();
  await page.getByLabel("Key Name").fill(`e2e-${testInfo.project.name}`);
  await expect(page.getByText("Read memories and sources")).toBeVisible();
  await expect(page.getByLabel("Expires")).toHaveValue("90");
  await page.getByRole("button", { name: "Create key" }).click();
  await expect(page.getByText("Copy it now")).toBeVisible();

  if (testInfo.project.name === "chromium") {
    const apiKey = (
      await page
        .locator("code")
        .filter({ hasText: /^fm_[a-f0-9]{48}$/ })
        .textContent()
    )?.trim();
    expect(apiKey).toMatch(/^fm_[a-f0-9]{48}$/);
    if (!apiKey) throw new Error("API key was not rendered");

    const headers = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };
    const addHeaders = {
      ...headers,
      "Idempotency-Key": "e2e-add-ada-drinks",
    };
    const addBody = {
      content: "Ada prefers oolong tea and avoids coffee.",
      user_id: "ada",
    };

    const add = await page.request.post("/v1/memories", {
      headers: addHeaders,
      data: addBody,
    });
    expect(add.status(), await add.text()).toBe(202);
    const accepted = (await add.json()) as {
      event_id: string;
      status: string;
    };

    const replay = await page.request.post("/v1/memories", {
      headers: addHeaders,
      data: addBody,
    });
    expect(replay.status(), await replay.text()).toBe(202);
    expect(await replay.json()).toEqual(accepted);

    const taskPoll = await page.request.post("/api/cron/tasks", {
      headers: { Authorization: "Bearer fishmem-e2e-cron-secret" },
    });
    expect(taskPoll.status(), await taskPoll.text()).toBe(200);

    const event = await page.request.get(
      `/v1/events/${encodeURIComponent(accepted.event_id)}`,
      { headers },
    );
    expect(event.status(), await event.text()).toBe(200);
    const added = (await event.json()) as {
      status: string;
      results: Array<{ id: string; memory: string; event: string }>;
    };
    expect(added.status).toBe("SUCCEEDED");
    expect(added.results).toHaveLength(2);
    expect(added.results.map((result) => result.memory)).toEqual([
      "Ada prefers oolong tea",
      "Ada avoids coffee",
    ]);

    const list = await page.request.get("/v1/memories?user_id=ada");
    expect(list.status()).toBe(401);
    const authenticatedList = await page.request.get(
      "/v1/memories?user_id=ada",
      { headers },
    );
    expect(authenticatedList.status(), await authenticatedList.text()).toBe(200);
    const listed = (await authenticatedList.json()) as {
      results: Array<{ id: string; memory: string }>;
      next_cursor: string | null;
    };
    expect(listed.results).toHaveLength(2);
    expect(listed.next_cursor).toBeNull();

    const search = await page.request.post("/v1/memories/search", {
      headers,
      data: {
        query: "What does Ada drink?",
        user_id: "ada",
        trace: true,
      },
    });
    expect(search.status(), await search.text()).toBe(200);
    const searched = (await search.json()) as {
      results: Array<{ id: string; memory: string }>;
      trace: { selected: string[] };
    };
    expect(searched.results.map((result) => result.memory)).toContain(
      "Ada prefers oolong tea",
    );
    expect(searched.trace.selected.length).toBeGreaterThan(0);

    const sourceContent =
      "# Deployment guide\n\n生产部署需要 violet approval，并保留回滚记录。";
    const sourceHeaders = {
      Authorization: headers.Authorization,
      "Idempotency-Key": "e2e-source-deployment-v1",
    };
    const sourceBody = {
      file: {
        name: "deployment.md",
        mimeType: "text/markdown",
        buffer: Buffer.from(sourceContent),
      },
      source_key: "handbook/deployment.md",
      title: "Deployment guide",
      mime_type: "text/markdown",
      user_id: "ada",
      metadata: JSON.stringify({ revision: 1 }),
    };
    const sourceIngest = await page.request.post("/v1/documents", {
      headers: sourceHeaders,
      multipart: sourceBody,
    });
    expect(sourceIngest.status(), await sourceIngest.text()).toBe(200);
    const source = (await sourceIngest.json()) as {
      created: boolean;
      chunks: number;
      document: {
        id: string;
        source_key: string;
        content_hash: string;
        version_hash: string;
        size_bytes: number;
      };
    };
    expect(source).toMatchObject({
      created: true,
      chunks: 1,
      document: { source_key: "handbook/deployment.md" },
    });
    expect(source.document.content_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(source.document.version_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(source.document.size_bytes).toBe(
      new TextEncoder().encode(sourceContent).byteLength,
    );

    const sourceReplay = await page.request.post("/v1/documents", {
      headers: sourceHeaders,
      multipart: sourceBody,
    });
    expect(sourceReplay.status(), await sourceReplay.text()).toBe(200);
    expect(await sourceReplay.json()).toEqual(source);

    const sourceList = await page.request.get("/v1/documents?user_id=ada", {
      headers,
    });
    expect(sourceList.status(), await sourceList.text()).toBe(200);
    await expect(sourceList.json()).resolves.toMatchObject({
      results: [
        {
          id: source.document.id,
          source_key: "handbook/deployment.md",
        },
      ],
      next_cursor: null,
    });

    const exactSource = await page.request.get(
      `/v1/documents/${source.document.id}/content`,
      { headers },
    );
    expect(exactSource.status(), await exactSource.text()).toBe(200);
    await expect(exactSource.json()).resolves.toEqual({
      id: source.document.id,
      content: sourceContent,
      content_hash: source.document.content_hash,
    });

    const sourceSearch = await page.request.post("/v1/documents/search", {
      headers,
      data: { query: "violet approval", user_id: "ada", neighbors: 1 },
    });
    expect(sourceSearch.status(), await sourceSearch.text()).toBe(200);
    const sourceSearchBody = (await sourceSearch.json()) as {
      results: Array<{
        document: { id: string };
        chunk: {
          document_id: string;
          content: string;
          start_byte: number;
          end_byte: number;
        };
      }>;
    };
    expect(sourceSearchBody.results[0]).toMatchObject({
      document: { id: source.document.id },
      chunk: {
        document_id: source.document.id,
        content: sourceContent,
        start_byte: 0,
        end_byte: new TextEncoder().encode(sourceContent).byteLength,
      },
    });

    await page.goto("/dashboard/sources");
    await expect(
      page.getByRole("heading", { name: "Sources", exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Deployment guide").first()).toBeVisible();
    await page.getByText("Deployment guide").first().click();
    await expect(page.getByText(sourceContent)).toBeVisible();
    await page.getByRole("button", { name: "Close", exact: true }).click();

    await page.getByRole("button", { name: "Add source" }).click();
    await page.locator('input[type="file"][accept*=".txt"]').setInputFiles({
      name: "dashboard-upload.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("# Dashboard upload\n\nExact multipart source.\n"),
    });
    await expect(page.getByLabel("Source key")).toHaveValue(
      "dashboard-upload.md",
    );
    await page.getByRole("button", { name: "Upload & extract" }).click();
    await expect(page.getByText("dashboard-upload.md").first()).toBeVisible();
    await page
      .getByRole("button", {
        name: "Delete upload dashboard-upload.md",
        exact: true,
      })
      .click();
    await page
      .getByRole("button", { name: "Delete upload", exact: true })
      .click();
    await expect(page.getByText("dashboard-upload.md")).toHaveCount(0);

    const memoryId = added.results[0]!.id;
    const update = await page.request.put(`/v1/memories/${memoryId}`, {
      headers: {
        ...headers,
        "Idempotency-Key": "e2e-update-ada-tea",
      },
      data: { content: "Ada prefers jasmine tea" },
    });
    expect(update.status(), await update.text()).toBe(200);
    await expect(update.json()).resolves.toMatchObject({
      id: memoryId,
      memory: "Ada prefers jasmine tea",
      event: "UPDATE",
    });

    const history = await page.request.get(
      `/v1/memories/${memoryId}/history`,
      { headers },
    );
    expect(history.status(), await history.text()).toBe(200);
    const historyBody = (await history.json()) as {
      results: Array<{ event: string; new_value: string | null }>;
    };
    expect(historyBody.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "UPDATE",
          new_value: "Ada prefers jasmine tea",
        }),
      ]),
    );

    const operations = await page.request.get("/v1/operations", { headers });
    expect(operations.status(), await operations.text()).toBe(200);
    const operationsBody = (await operations.json()) as {
      results: Array<{ kind: string; status: string }>;
    };
    expect(operationsBody.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "add", status: "committed" }),
        expect.objectContaining({ kind: "update", status: "committed" }),
      ]),
    );

    const remove = await page.request.delete(`/v1/memories/${memoryId}`, {
      headers: {
        ...headers,
        "Idempotency-Key": "e2e-delete-ada-tea",
      },
    });
    expect(remove.status(), await remove.text()).toBe(200);
    await expect(remove.json()).resolves.toEqual({
      id: memoryId,
      deleted: true,
    });
    const removeReplay = await page.request.delete(
      `/v1/memories/${memoryId}`,
      {
        headers: {
          ...headers,
          "Idempotency-Key": "e2e-delete-ada-tea",
        },
      },
    );
    expect(removeReplay.status(), await removeReplay.text()).toBe(200);
    await expect(removeReplay.json()).resolves.toEqual({
      id: memoryId,
      deleted: true,
    });

    await page.goto("/dashboard/requests");
    await expect(
      page.getByRole("heading", { name: "Requests", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /ADD ada —/ }).first(),
    ).toBeVisible();

    await page.goto("/dashboard/memories");
    await expect(page.getByText("Ada avoids coffee").first()).toBeVisible();
    await expect(page.getByText("Ada prefers jasmine tea")).toHaveCount(0);
    await page
      .getByRole("button", {
        name: "Open memory: Ada avoids coffee",
        exact: true,
      })
      .click();
    await expect(
      page.getByRole("heading", { name: "Memory details", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Source & history", exact: true })
      .click();
    await expect(page.getByText("Immutable history")).toBeVisible();
    await page
      .getByRole("button", { name: "Close memory details", exact: true })
      .click();
    await page
      .getByLabel("Semantic search across memories")
      .fill("What does Ada avoid?");
    await page
      .getByRole("button", { name: "Search memories", exact: true })
      .click();
    await expect(page.getByText("Ranked by recall relevance")).toBeVisible();
    await expect(page.getByText("Ada avoids coffee").first()).toBeVisible();

    const exportResponse = await page.request.post("/v1/exports", {
      headers: {
        ...headers,
        "Idempotency-Key": "e2e-export-after-delete",
      },
    });
    expect(exportResponse.status(), await exportResponse.text()).toBe(202);
    const exportTask = (await exportResponse.json()) as { id: string };
    const completedExport = await page.request.get(
      `/v1/operations/${exportTask.id}`,
      { headers },
    );
    expect(completedExport.status(), await completedExport.text()).toBe(200);
    const completedExportBody = (await completedExport.json()) as {
      status: string;
      result: {
        sourceNamespaceId: string;
        data: {
          memories: Array<{ id: string; forgotten: boolean }>;
          documents: Array<{ id: string; content: string }>;
          documentHeads: Array<{ documentId: string }>;
          documentChunks: Array<{ documentId: string; content: string }>;
          history: Array<{ memoryId: string; event: string }>;
        };
      };
    };
    expect(completedExportBody.status).toBe("success");
    expect(completedExportBody.result.data.memories).toHaveLength(2);
    expect(completedExportBody.result.data.documents).toEqual([
      expect.objectContaining({
        id: source.document.id,
        content: sourceContent,
      }),
    ]);
    expect(completedExportBody.result.data.documentHeads).toEqual([
      expect.objectContaining({ documentId: source.document.id }),
    ]);
    expect(completedExportBody.result.data.documentChunks).toEqual([
      expect.objectContaining({
        documentId: source.document.id,
        content: sourceContent,
      }),
    ]);
    expect(completedExportBody.result.data.history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ memoryId, event: "UPDATE" }),
        expect.objectContaining({ memoryId, event: "DELETE" }),
      ]),
    );

    const projectsResponse = await page.request.get("/api/app/projects");
    expect(projectsResponse.status(), await projectsResponse.text()).toBe(200);
    const projectsBody = (await projectsResponse.json()) as {
      data: Array<{ documentId: string }>;
    };
    expect(projectsBody.data).toHaveLength(1);
    const sourceProjectId = projectsBody.data[0]!.documentId;
    expect(completedExportBody.result.sourceNamespaceId).toBe(sourceProjectId);

    const targetProjectResponse = await page.request.post("/api/app/projects", {
      data: { name: "Restored Project", description: "E2E restore target" },
    });
    expect(
      targetProjectResponse.status(),
      await targetProjectResponse.text(),
    ).toBe(200);
    const targetProject = (await targetProjectResponse.json()) as {
      data: { documentId: string };
    };
    const targetProjectId = targetProject.data.documentId;
    const targetTokenResponse = await page.request.post(
      "/api/app/api-tokens",
      {
        data: {
          name: "e2e-restore-key",
          workspace: targetProjectId,
          permissions: ["memory:read", "memory:write", "operations:read"],
        },
      },
    );
    expect(targetTokenResponse.status(), await targetTokenResponse.text()).toBe(
      200,
    );
    const targetToken = (await targetTokenResponse.json()) as {
      data: { token: string };
    };
    expect(targetToken.data.token).toMatch(/^fm_[a-f0-9]{48}$/);

    const deleteProjectResponse = await page.request.delete(
      `/api/app/projects/${sourceProjectId}`,
    );
    expect(
      deleteProjectResponse.status(),
      await deleteProjectResponse.text(),
    ).toBe(204);
    const revokedSourceKey = await page.request.get(
      "/v1/memories?user_id=ada",
      { headers },
    );
    expect(revokedSourceKey.status()).toBe(401);

    await page.evaluate((workspaceId) => {
      localStorage.setItem("fishmem:selected-project", workspaceId);
    }, targetProjectId);
    await page.goto("/dashboard/settings#backup");
    await expect(
      page.getByText("Restore a FishMem JSON snapshot into this project."),
    ).toBeVisible();
    await page.locator('input[type="file"]').setInputFiles({
      name: "fishmem-e2e-snapshot.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(completedExportBody.result)),
    });
    await page.getByRole("button", { name: "Restore snapshot" }).click();
    await expect(page.getByText(/Restore queued/)).toBeVisible();

    const targetHeaders = {
      Authorization: `Bearer ${targetToken.data.token}`,
      "Content-Type": "application/json",
    };
    const restoredList = await page.request.get(
      "/v1/memories?user_id=ada",
      { headers: targetHeaders },
    );
    expect(restoredList.status(), await restoredList.text()).toBe(200);
    const restoredListBody = (await restoredList.json()) as {
      results: Array<{ id: string; memory: string }>;
    };
    expect(restoredListBody.results).toEqual([
      expect.objectContaining({
        id: added.results[1]!.id,
        memory: "Ada avoids coffee",
      }),
    ]);
    const restoredHistory = await page.request.get(
      `/v1/memories/${memoryId}/history`,
      { headers: targetHeaders },
    );
    expect(restoredHistory.status(), await restoredHistory.text()).toBe(200);
    const restoredHistoryBody = (await restoredHistory.json()) as {
      results: Array<{ event: string }>;
    };
    expect(restoredHistoryBody.results.map((entry) => entry.event)).toEqual(
      expect.arrayContaining(["ADD", "UPDATE", "DELETE"]),
    );
    const restoredSourceList = await page.request.get(
      "/v1/documents?user_id=ada",
      { headers: targetHeaders },
    );
    expect(
      restoredSourceList.status(),
      await restoredSourceList.text(),
    ).toBe(200);
    await expect(restoredSourceList.json()).resolves.toMatchObject({
      results: [
        {
          id: source.document.id,
          source_key: "handbook/deployment.md",
          content_hash: source.document.content_hash,
        },
      ],
    });
    const restoredSource = await page.request.get(
      `/v1/documents/${source.document.id}/content`,
      { headers: targetHeaders },
    );
    expect(restoredSource.status(), await restoredSource.text()).toBe(200);
    await expect(restoredSource.json()).resolves.toMatchObject({
      id: source.document.id,
      content: sourceContent,
    });
    const deleteRestoredSource = await page.request.delete(
      `/v1/documents/${source.document.id}`,
      {
        headers: {
          ...targetHeaders,
          "Idempotency-Key": "e2e-delete-restored-source",
        },
      },
    );
    expect(
      deleteRestoredSource.status(),
      await deleteRestoredSource.text(),
    ).toBe(200);
    await expect(deleteRestoredSource.json()).resolves.toEqual({
      id: source.document.id,
      deleted: true,
      versions: 1,
      chunks: 1,
    });
    const replayDeleteRestoredSource = await page.request.delete(
      `/v1/documents/${source.document.id}`,
      {
        headers: {
          ...targetHeaders,
          "Idempotency-Key": "e2e-delete-restored-source",
        },
      },
    );
    expect(
      replayDeleteRestoredSource.status(),
      await replayDeleteRestoredSource.text(),
    ).toBe(200);
    await expect(replayDeleteRestoredSource.json()).resolves.toEqual({
      id: source.document.id,
      deleted: true,
      versions: 1,
      chunks: 1,
    });
    const newDeleteRestoredSource = await page.request.delete(
      `/v1/documents/${source.document.id}`,
      {
        headers: {
          ...targetHeaders,
          "Idempotency-Key": "e2e-delete-restored-source-new-command",
        },
      },
    );
    expect(newDeleteRestoredSource.status()).toBe(404);
    const deletedSource = await page.request.get(
      `/v1/documents/${source.document.id}/content`,
      { headers: targetHeaders },
    );
    expect(deletedSource.status()).toBe(404);
    const restoredOperations = await page.request.get("/v1/operations", {
      headers: targetHeaders,
    });
    expect(
      restoredOperations.status(),
      await restoredOperations.text(),
    ).toBe(200);
    const restoredOperationsBody = (await restoredOperations.json()) as {
      results: Array<{ kind: string; status: string }>;
    };
    expect(restoredOperationsBody.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "import", status: "success" }),
      ]),
    );
  }
});
