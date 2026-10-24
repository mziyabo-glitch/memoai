-- Already applied on MemoAi as version 20261024150809.
-- Kept here so local history matches the remote project. Do not edit.
-- This does not grant new access. It stops the trigger functions from
-- inheriting a caller-controlled search_path.

alter function public.set_updated_at() set search_path = '';
alter function public.protect_processing_job() set search_path = '';
