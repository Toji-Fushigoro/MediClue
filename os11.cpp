#include <iostream>
#include <string>
#include <ctime>
#include <cstdio>
using namespace std;
#include <vector>
#include <algorithm>

struct PatientProcess
{
    int appointmentId;
    int patientId;
    int doctorId;
    string patientName;
    string doctorName;
    string priority;
    string appointmentType;
    string arrivalTime;
    long long waitingMinutes;
    int priorityTier;
};

int getPriorityTier(string priority)
{
    if (priority == "Critical" || priority == "Emergency")
        return 0;
    else if (priority == "High" || priority == "Urgent")
        return 1;
    else if (priority == "Medium" || priority == "Normal")
        return 2;
    else
        return 3;
}

long long calculateWaitingMinutes(string arrivalTime)
{
    int hours = 0, minutes = 0;

    sscanf(arrivalTime.c_str(), "%d:%d", &hours, &minutes);

    time_t now = time(0);
    tm *local = localtime(&now);

    int currentTime = local->tm_hour * 60 + local->tm_min;
    int arrival = hours * 60 + minutes;

    if (arrival > currentTime)
        return 0;

    return currentTime - arrival;
}

void applyPriorityScheduling(vector<PatientProcess>& readyQueue)
{
    for (auto& process : readyQueue)
    {
        process.priorityTier = getPriorityTier(process.priority);
        process.waitingMinutes = calculateWaitingMinutes(process.arrivalTime);
    }

    sort(readyQueue.begin(), readyQueue.end(),
        [](const PatientProcess& a, const PatientProcess& b)
        {
            if (a.priorityTier != b.priorityTier)
                return a.priorityTier < b.priorityTier;

            if (a.waitingMinutes != b.waitingMinutes)
                return a.waitingMinutes > b.waitingMinutes;

            return a.appointmentId < b.appointmentId;
        });
}