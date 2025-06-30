/*
 * Copyright (c) 2022, NVIDIA CORPORATION.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  PushContext,
  PayloadRepository,
  PullsListResponseData,
} from "../../types.ts";
import { basename } from "path";
import { resolve } from "path";
import { readFileSync } from "fs";
import nunjucks from "nunjucks";
import { getVersionFromBranch, isVersionedBranch } from "../../shared.ts";
import axios from "axios";
import { OpsBotPlugin } from "../../plugin.ts";

export class ReleaseDrafter extends OpsBotPlugin {
  context: PushContext;
  branchName: string;
  repo: PayloadRepository;
  releaseTagName: string;
  branchVersionNumber: string;
  releaseTitle: string;
  mergeSHA: string;
  defaultBranch: string;

  constructor(context: PushContext) {
    super("release_drafter", context);
    this.context = context;
    this.branchName = basename(context.payload.ref);
    this.repo = context.payload.repository;
    this.branchVersionNumber = getVersionFromBranch(this.branchName);
    this.releaseTagName = `v${this.branchVersionNumber}.00a`;
    this.releaseTitle = `[NIGHTLY] v${this.branchVersionNumber}.00`;
    this.mergeSHA = context.payload.after;
    this.defaultBranch = this.repo.default_branch;
  }

  async draftRelease(): Promise<any> {
    const { context } = this;
    if (await this.pluginIsDisabled()) return;
    const { created, deleted } = context.payload;

    // Don't run on branch created/delete pushes
    if (created || deleted) {
      this.logger.info("no drafts on create/delete");
      return;
    }

    // Only run draft-releaser on valid release branches
    if (!(await this.isValidBranch())) {
      this.logger.info("invalid branch");
      return;
    }

    this.logger.info("drafting release");

    const prs =
      this.defaultBranch === "main"
        ? await this.getPRsForNewStrategy()
        : await this.getPRsForLegacyStrategy();
    const releaseDraftBody = this.getReleaseDraftBody(prs);
    const releaseId = await this.getExistingDraftReleaseId();
    await this.createOrUpdateDraftRelease(releaseId, releaseDraftBody);
  }

  /**
   * Returns true if the branch name is valid. Valid branches should match
   * the branch-yy.mm or release/yy.mm pattern and exist in releases.json
   */
  async isValidBranch(): Promise<boolean> {
    if (!isVersionedBranch(this.branchName)) return false;
    const { branchVersionNumber } = this;

    const { data: json } = await axios.get<{
      legacy: { version };
      stable: { version };
      nightly: { version };
    }>(
      `https://raw.githubusercontent.com/rapidsai/docs/main/_data/releases.json`
    );

    return [
      json.stable.version,
      json.nightly.version,
      json.legacy.version,
    ].includes(branchVersionNumber);
  }

  /**
   * (New Strategy)
   * Returns all PRs for a release by inspecting the git history between the
   * release's alpha tag and the current HEAD of the release branch.
   */
  async getPRsForNewStrategy(): Promise<PullsListResponseData> {
    const { context, repo, branchName, branchVersionNumber } = this;
    const owner = repo.owner.login;
    const repoName = repo.name;
    const startTag = `v${branchVersionNumber}.00a`;

    // 1. Get commits between the start tag and the release branch HEAD
    let commits: { commit: { message: string } }[] = [];
    try {
      const { data } = await context.octokit.repos.compareCommits({
        owner,
        repo: repoName,
        base: startTag,
        head: branchName,
      });
      commits = data.commits;
    } catch (e) {
      this.logger.error(
        e,
        `Failed to compare commits between ${startTag} and ${branchName}`
      );
      return [];
    }

    // 2. Extract PR numbers from squash-merge commits
    const prNumbers = new Set<number>();
    const prRegex = /\(#(\d+)\)/;
    for (const commit of commits) {
      const match = commit.commit.message.match(prRegex);
      if (match && match[1]) {
        prNumbers.add(parseInt(match[1], 10));
      }
    }

    // 3. Get PRs that were merged directly into the release branch
    const directMergePrs = await context.octokit.paginate(
      context.octokit.pulls.list,
      {
        owner,
        repo: repoName,
        base: branchName,
        state: "closed",
        per_page: 100,
      }
    );
    directMergePrs
      .filter((pr) => pr.merged_at)
      .forEach((pr) => prNumbers.add(pr.number));

    // 4. Fetch full PR objects for all unique PR numbers
    const prPromises = Array.from(prNumbers).map((prNumber) =>
      context.octokit.pulls
        .get({
          owner,
          repo: repoName,
          pull_number: prNumber,
        })
        .then((response) => response.data)
        .catch((e) => {
          this.logger.error(e, `Failed to fetch PR #${prNumber}`);
          return null;
        })
    );

    const prs = (await Promise.all(prPromises)).filter(
      (pr) => pr !== null
    ) as PullsListResponseData;

    return prs;
  }

  /**
   * (Legacy Strategy)
   * Returns all non-forward-merger PRs that have been merged into
   * the repo's base branch.
   */
  async getPRsForLegacyStrategy(): Promise<PullsListResponseData> {
    const { context, repo, branchName } = this;

    const prs = await context.octokit.paginate(context.octokit.pulls.list, {
      owner: repo.owner.login,
      repo: repo.name,
      base: branchName,
      state: "closed",
      per_page: 100,
    });

    return prs
      .filter(
        (pr) =>
          pr.user?.login.toLowerCase() !== "rapids-bot" &&
          pr.user?.login.toLowerCase() !== "gputester"
      )
      .filter((pr) => pr.merged_at); // merged_at === null for PRs that were closed, but not merged
  }

  /**
   * Returns the body string for the release draft
   * @param prs
   */
  getReleaseDraftBody(prs: PullsListResponseData): string {
    const { releaseTitle, branchVersionNumber, branchName, repo } = this;
    const categories = {
      bug: { title: "🐛 Bug Fixes", prs: [] },
      doc: { title: "📖 Documentation", prs: [] },
      "feature request": { title: "🚀 New Features", prs: [] },
      improvement: { title: "🛠️ Improvements", prs: [] },
    };

    const breakingPRs: PullsListResponseData = [];

    const categoryFromLabels = (label) =>
      Object.keys(categories).includes(label.name);
    let hasEntries = false;
    for (let i = 0; i < prs.length; i++) {
      const pr = prs[i];
      const categoryLabel = pr.labels.find(categoryFromLabels);
      if (!categoryLabel) {
        this.logger.info({ pr }, "no category label found");
        continue;
      }
      const category = categoryLabel.name as string; // this will be a string based on checks above
      categories[category].prs.push(pr);
      hasEntries = true;

      if (pr.labels.find((el) => el.name === "breaking")) {
        breakingPRs.push(pr);
      }
    }

    const templatePath = resolve(__dirname, "draft_template.njk");
    const templateStr = readFileSync(templatePath, "utf-8");

    const nj = new nunjucks.Environment(null, {
      trimBlocks: true,
      lstripBlocks: true,
    });

    return nj
      .renderString(templateStr, {
        categories,
        releaseTitle,
        hasEntries,
        breaking: breakingPRs,
        versionNumber: branchVersionNumber,
        branchName,
        repoFullName: repo.full_name,
      })
      .trim();
  }

  /**
   * Returns the numerical ID of an existing prerelease whose tag is <releaseTagName>.
   * If no prerelease exists, returns -1.
   */
  async getExistingDraftReleaseId(): Promise<number> {
    const { context, repo, releaseTagName } = this;

    try {
      const { data: release } = await context.octokit.repos.getReleaseByTag({
        repo: repo.name,
        owner: repo.owner.login,
        tag: releaseTagName,
      });
      return release.id;
    } catch (error) {
      this.logger.info("no existing release");
      return -1;
    }
  }

  /**
   * Creates a new release or updates an existing release and the associated
   * git tag.
   * @param releaseId
   * @param releaseBody
   */
  async createOrUpdateDraftRelease(releaseId: number, releaseBody: string) {
    const { context, releaseTitle, releaseTagName, repo } = this;
    const owner = repo.owner.login;
    const repo_name = repo.name;

    if (releaseId !== -1) {
      await context.octokit.repos.updateRelease({
        owner,
        repo: repo_name,
        release_id: releaseId,
        body: releaseBody,
      });
      return;
    }

    // The createRelease endpoint also creates the tag if
    // it doesn't exist.
    await context.octokit.repos.createRelease({
      owner,
      repo: repo_name,
      tag_name: releaseTagName,
      name: releaseTitle,
      prerelease: true,
      body: releaseBody,
    });
  }
}
