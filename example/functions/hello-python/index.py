# Pure Python, standard library only: the same zip runs on x86_64 and on arm64.
import json
import platform


def handler(event, context):
    return {"statusCode": 200, "body": json.dumps({"message": "hello", "arch": platform.machine()})}
