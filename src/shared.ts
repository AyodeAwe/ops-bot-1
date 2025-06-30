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
  AutoMergerContext,
  CommitStatus,
  IssueCommentContext,
  IssuesCommentsResponseData,
  MergeCommentResult,
  PRContext,
  ProbotOctokit,
  PullRequestLike,
} from "./types.ts";

export const Permission = {
  admin: "admin",
  write: "write",
  maintain: "maintain",
};

/**
 * Returns true if the provided string is a versioned branch
 * (i.e. "branch-21.06", "release/22.08", etc.)
 * @param branchName
 */
export const isVersionedBranch = (branchName: string): boolean => {
  return /^(branch-|release\/)\d{2}\.\d{2}$/.test(branchName);
};

/**
 * Returns true if the provided string is a versioned branch that follows the ucxx/py versioning scheme
 * (i.e. "branch-0.36", "branch-0.40", etc.)
 * @param branchName
 */
export const isVersionedUCXBranch = (branchName: string): boolean => {
  const regex = /^branch-\d{1,2}\.\d\d$/;
  return Boolean(branchName.match(regex));
};

/**
 * Returns the RAPIDS version from a versioned branch name
 * (e.g. "branch-22.06" -> "22.06", "release/22.08" -> "22.08")
 */
export const getVersionFromBranch = (branchName: string): string => {
  const match = branchName.match(/\d{2}\.\d{2}/);
  if (match) {
    return match[0];
  }
  return "";
};

/**
 * Parses a merge comment to determine if it's a valid command and the intended merge method.
 * Handles "/merge" and "/merge nosquash".
 * @param commentText The comment string.
 * @returns An object with `isMergeComment` (boolean) and `method` ("squash" | "merge" | null).
 */
export const parseMergeComment = (commentText: string): MergeCommentResult => {
  const trimmedComment = commentText.trim();
  const result = /^\/merge(?: (?<method>nosquash))?$/.exec(trimmedComment);

  if (result) {
    const method = result.groups!.method ? "merge" : "squash";
    return {
      isMergeComment: true,
      method,
    };
  }

  return {
    isMergeComment: false,
    method: null
  };
};

/**
 * Returns true if the provided branch name follows a recognized manual forward-merge naming convention.
 * @param branchName
 */
export const isManualForwardMergeBranch = (branchName: string): boolean => {
  return Boolean(parseManualForwardMergeBranch(branchName));
};

/**
 * Parses a manual forward-merge branch name to extract source and target branches.
 * Handles patterns like "branch-YY.MM-merge-branch-YY.MM", "branch-YY.MM-merge-YY.MM", and "main-merge-release/YY.MM".
 * @param branchName The branch name string.
 * @returns Object with source and target branch names (full names), or null if not a recognized forward-merge branch name.
 */
export const parseManualForwardMergeBranch = (branchName: string): { source: string; target: string } | null => {
  const MAIN_FORWARD_MERGE_RELEASE_BRANCH_REGEX = /^(?<target>main)-merge-(?<source>release\/\d\d\.\d\d)$/;
  const BRANCH_FORWARD_MERGE_BRANCH_REGEX = /^branch-(?<targetVersion>\d{1,2}\.\d\d)-merge(?:-branch)?-(?<sourceVersion>\d{1,2}\.\d\d)$/;
  const trimmedBranchName = branchName.trim();
  let match = BRANCH_FORWARD_MERGE_BRANCH_REGEX.exec(trimmedBranchName);

  if (match?.groups?.targetVersion && match?.groups?.sourceVersion) {
    return {
      target: `branch-${match.groups.targetVersion}`,
      source: `branch-${match.groups.sourceVersion}`
    };
  }

  match = MAIN_FORWARD_MERGE_RELEASE_BRANCH_REGEX.exec(trimmedBranchName);
  if (match?.groups?.target && match?.groups?.source) {
    return {
      target: match.groups.target, // e.g. "main"
      source: match.groups.source  // e.g. "release/25.04"
    };
  }
  return null;
};

/**
 * Returns an async function that will set a status on a given
 * commit. The returned function accepts a description, a state,
 * and an optional target URL.
 */
export const createSetCommitStatus = (
  octokit: ProbotOctokit,
  { context, owner, repo, sha, target_url = "" }: CommitStatus
) => {
  type StateStrings = "success" | "failure" | "error" | "pending";

  const initialTargetUrl = target_url;
  return async (
    description: string,
    state: StateStrings,
    target_url = initialTargetUrl
  ) => {
    await octokit.repos.createCommitStatus({
      context,
      owner,
      repo,
      sha,
      state,
      description,
      target_url,
      request: {
        retries: 3,
        retryAfter: 10,
      },
    });
  };
};

export const isGPUTesterPR = (
  pullRequest: PullRequestLike
): boolean => {
  return pullRequest.user?.login.toLowerCase() === "gputester";
};

export const isRapidsBotPR = (
  pullRequest: PullRequestLike
): boolean => {
  return pullRequest.user?.login.toLowerCase() === "rapids-bot[bot]";
};

export const isOpsBotTestingPR = (
  pullRequest: PullRequestLike
): boolean => {
  return pullRequest.user?.login.toLowerCase() === "ops-bot-testing[bot]";
};

/**
 * Returns true if the payload associated with the provided context
 * is from a GitHub Pull Request (as opposed to a GitHub Issue).
 * @param context
 */
export const issueIsPR = (context: IssueCommentContext): boolean => {
  return "pull_request" in context.payload.issue;
};

/**
 * Retrieves the issue/PR comments that fit provided criteria
 * @param context
 * @param prNumber
 * @param requiredPermissions
 * @param predicate
 */
export async function validCommentsExistByPredicate(
  context: AutoMergerContext | PRContext,
  prNumber: number,
  requiredPermissions: string[],
  predicate: (comment: IssuesCommentsResponseData[0]) => Boolean
) {
  const repo = context.payload.repository;

  const allComments = await context.octokit.paginate(
    context.octokit.issues.listComments,
    {
      owner: repo.owner.login,
      repo: repo.name,
      issue_number: prNumber,
    }
  );

  var filteredComments: IssuesCommentsResponseData = [];
  for (let i = 0; i < allComments.length; i++) {
    if (predicate(allComments[i])) {
      filteredComments.push(allComments[i]);
    }
  }

  const commentAuthors = filteredComments
    .map((comment) => comment.user?.login)
    .filter(Boolean);

  const authorPermissions = await Promise.all(
    commentAuthors.map(async (actor) => {
      return (
        await context.octokit.repos.getCollaboratorPermissionLevel({
          owner: repo.owner.login,
          repo: repo.name,
          username: actor as string,
        })
      ).data.permission;
    })
  );

  return authorPermissions.some((permission) =>
    requiredPermissions.includes(permission)
  );
}
