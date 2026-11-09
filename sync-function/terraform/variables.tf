variable "project_id" {
  description = "The Google Cloud project the function is deployed in"
  type        = string
}

variable "region" {
  description = "Region of the function and its source bucket"
  type        = string
  default     = "europe-west1"
}

variable "function_name" {
  description = "Name of the function; also used for its service accounts and source bucket"
  type        = string
  default     = "ge-log-sync"
}

variable "log_project" {
  description = "The project the Gemini Enterprise logs are written to; empty: project_id"
  type        = string
  default     = ""
}

variable "bucket" {
  description = "The report's bucket (must already exist)"
  type        = string
}

variable "client_id" {
  description = "The report's OAuth client ID (GCS_CLIENT_ID in src/app.js)"
  type        = string
}

variable "allowed_domain" {
  description = "The organization's email domain; several: comma-separated"
  type        = string
}

variable "ge_app" {
  description = "Optional: one Gemini Enterprise app's engine id, to leave the project's other apps out; empty: every app"
  type        = string
  default     = ""
}

variable "log_filter" {
  description = "Optional: a Logging filter replacing the function's default (ge_app then has no effect)"
  type        = string
  default     = ""
}

variable "runtime" {
  description = "Node.js runtime of the function"
  type        = string
  default     = "nodejs22"
}

variable "timeout_seconds" {
  description = "Request timeout; the first sync reads 30 days of logs"
  type        = number
  default     = 300
}
