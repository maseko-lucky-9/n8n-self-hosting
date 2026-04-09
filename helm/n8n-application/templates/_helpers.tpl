{{/*
Expand the name of the chart.
*/}}
{{- define "n8n-application.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this (by the DNS naming spec).
If release name contains chart name it will be used as a full name.
*/}}
{{- define "n8n-application.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "n8n-application.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "n8n-application.labels" -}}
helm.sh/chart: {{ include "n8n-application.chart" . }}
{{ include "n8n-application.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "n8n-application.selectorLabels" -}}
app.kubernetes.io/name: {{ include "n8n-application.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Create the name of the service account to use
*/}}
{{- define "n8n-application.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "n8n-application.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Stable name for the PostgreSQL ClusterIP service.
Single source of truth — change here to rename the service everywhere.
*/}}
{{- define "n8n-application.postgresServiceName" -}}
postgres-service
{{- end }}

{{/*
Stable name for the PostgreSQL credentials Secret (inline or ESO-managed).
*/}}
{{- define "n8n-application.postgresSecretName" -}}
postgres-secret
{{- end }}

{{/*
Stable name for the n8n application Secret (encryption key, webhook URL).
*/}}
{{- define "n8n-application.appSecretName" -}}
n8n-app-secret
{{- end }}

{{/*
Validate: TLS must not be enabled without cert-manager annotation.
Prevents broken ingress on restart when TLS secret doesn't exist.
*/}}
{{- define "n8n-application.validateTLS" -}}
{{- if and .Values.ingress.enabled .Values.ingress.tls }}
  {{- $hasCertManager := index .Values.ingress.annotations "cert-manager.io/cluster-issuer" }}
  {{- $hasExistingSecret := false }}
  {{- range .Values.ingress.tls }}
    {{- if .secretName }}{{- $hasExistingSecret = true }}{{- end }}
  {{- end }}
  {{- if not (or $hasCertManager $hasExistingSecret) }}
    {{- fail "ingress.tls is enabled but neither cert-manager.io/cluster-issuer annotation nor a secretName is set." }}
  {{- end }}
{{- end }}
{{- end }}
