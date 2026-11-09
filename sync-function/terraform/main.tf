# The log sync function (../index.js, ../sync.js) as a Cloud Run function, with its own service account.
#
#   cp terraform.tfvars.example terraform.tfvars    # fill in this environment's values
#   terraform init
#   terraform apply
#
# The report's bucket must already exist; this grants the function access to it and doesn't manage it.
# The output `url` goes into the report's SYNC_URL GitHub secret.

terraform {
  required_version = ">= 1.5"
  required_providers {
    google  = { source = "hashicorp/google", version = ">= 6.0, < 8.0" }
    archive = { source = "hashicorp/archive", version = "~> 2.4" }
    time    = { source = "hashicorp/time", version = "~> 0.11" }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

locals {
  log_project = coalesce(var.log_project, var.project_id)
}

resource "google_project_service" "apis" {
  for_each = toset([
    "cloudfunctions.googleapis.com",
    "run.googleapis.com",
    "cloudbuild.googleapis.com",
    "artifactregistry.googleapis.com",
    "logging.googleapis.com",
    "storage.googleapis.com",
  ])
  service            = each.value
  disable_on_destroy = false
}

# ---- Who the function runs as: reads the logs, writes the synced files ----

resource "google_service_account" "sync" {
  account_id   = var.function_name
  display_name = "Log sync (${var.function_name})"
}

resource "google_project_iam_member" "sync_logs" {
  project = local.log_project
  role    = "roles/logging.viewer"
  member  = "serviceAccount:${google_service_account.sync.email}"
}

# Creator to write the files and markers (create-only), Viewer to find the last marker.
resource "google_storage_bucket_iam_member" "sync_bucket" {
  for_each = toset(["roles/storage.objectCreator", "roles/storage.objectViewer"])
  bucket   = var.bucket
  role     = each.value
  member   = "serviceAccount:${google_service_account.sync.email}"
}

# ---- Who builds it: a dedicated account, as new projects' default build account may lack these roles ----

resource "google_service_account" "build" {
  account_id   = "${var.function_name}-build"
  display_name = "Log sync build (${var.function_name})"
}

resource "google_project_iam_member" "build" {
  for_each = toset(["roles/logging.logWriter", "roles/artifactregistry.writer", "roles/storage.objectAdmin"])
  project  = var.project_id
  role     = each.value
  member   = "serviceAccount:${google_service_account.build.email}"
}

# Granted roles take a moment to apply before the build can pull the source.
resource "time_sleep" "build_roles" {
  depends_on      = [google_project_iam_member.build]
  create_duration = "60s"
}

# ---- The source: the function's three files, zipped and uploaded; a change uploads a new object and redeploys ----

data "archive_file" "source" {
  type        = "zip"
  output_path = "${path.module}/.build/${var.function_name}.zip"
  source {
    content  = file("${path.module}/../index.js")
    filename = "index.js"
  }
  source {
    content  = file("${path.module}/../sync.js")
    filename = "sync.js"
  }
  source {
    content  = file("${path.module}/../package.json")
    filename = "package.json"
  }
}

resource "google_storage_bucket" "source" {
  name                        = "${var.project_id}-${var.function_name}-src"
  location                    = var.region
  uniform_bucket_level_access = true
  force_destroy               = true
  depends_on                  = [google_project_service.apis]
}

resource "google_storage_bucket_object" "source" {
  name   = "${var.function_name}-${data.archive_file.source.output_md5}.zip"
  bucket = google_storage_bucket.source.name
  source = data.archive_file.source.output_path
}

# ---- The function ----

resource "google_cloudfunctions2_function" "sync" {
  name     = var.function_name
  location = var.region

  build_config {
    runtime         = var.runtime
    entry_point     = "sync"
    service_account = google_service_account.build.id
    source {
      storage_source {
        bucket = google_storage_bucket.source.name
        object = google_storage_bucket_object.source.name
      }
    }
  }

  service_config {
    service_account_email = google_service_account.sync.email
    available_memory      = "512M"
    timeout_seconds       = var.timeout_seconds
    # One instance: the function runs one sync at a time and hands concurrent callers its result, which only holds
    # within a single instance.
    max_instance_count               = 1
    max_instance_request_concurrency = 80
    ingress_settings                 = "ALLOW_ALL"
    all_traffic_on_latest_revision   = true
    environment_variables = {
      LOG_PROJECT    = local.log_project
      BUCKET         = var.bucket
      CLIENT_ID      = var.client_id
      ALLOWED_DOMAIN = var.allowed_domain
      GE_APP         = var.ge_app
      LOG_FILTER     = var.log_filter
    }
  }

  depends_on = [google_project_service.apis, time_sleep.build_roles]
}

# Public: the report's page calls it straight from the browser. The function checks every caller's token itself.
resource "google_cloud_run_service_iam_member" "public" {
  location = var.region
  service  = google_cloudfunctions2_function.sync.service_config[0].service
  role     = "roles/run.invoker"
  member   = "allUsers"
}

output "url" {
  description = "The function's URL: the report's SYNC_URL GitHub secret"
  value       = google_cloudfunctions2_function.sync.service_config[0].uri
}

output "service_account" {
  description = "The account the function runs as"
  value       = google_service_account.sync.email
}
